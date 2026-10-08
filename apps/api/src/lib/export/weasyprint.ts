import { ApiError } from '../core/errors';
import renderScript from './weasyprint-render.py' with { type: 'file' };

// The largest @page side an export asks WeasyPrint for: 200 inches, the PDF page limit. A page sized from
// collaborator data (a huge column width, a drawing element far out) would otherwise cost WeasyPrint
// without bound. Content past it continues on the next page or is cut at the right edge.
export const MAX_PDF_PAGE_PX = 19_200;

// The first with the URLFetcher class weasyprint-render.py subclasses.
const MIN_WEASYPRINT_MAJOR = 68;

type WeasyPrintProbe = { python: string } | { python: null; found: string | null };

let cachedProbe: Promise<WeasyPrintProbe> | null = null;

// The Python that imports a WeasyPrint of at least MIN_WEASYPRINT_MAJOR: the one the `weasyprint` launcher names (a pip
// venv's, Homebrew's own), else python3. `-I` keeps the cwd and the environment off its module path. Else the version
// it found, which the 501 names.
async function probeWeasyPrint(): Promise<WeasyPrintProbe> {
    const launcher = Bun.which('weasyprint');
    const shebang = launcher
        ? (await Bun.file(launcher).slice(0, 512).text()).match(/^#![ \t]*(\S+)(?:[ \t]+(\S+))?/)
        : null;
    const named = shebang?.[1].endsWith('/env') ? shebang[2] : shebang?.[1];
    let found: string | null = null;
    for (const python of new Set([named, 'python3'])) {
        if (!python) continue;
        try {
            const proc = Bun.spawn([python, '-I', '-c', 'import weasyprint; print(weasyprint.__version__)'], {
                stdout: 'pipe',
                stderr: 'ignore',
            });
            const [exitCode, version] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
            if (exitCode !== 0) continue;
            found = version.trim();
            if (Number.parseInt(found, 10) >= MIN_WEASYPRINT_MAJOR) return { python };
        } catch {
            // Not installed: try the next one.
        }
    }
    return { python: null, found };
}

const weasyPrint = (): Promise<WeasyPrintProbe> => (cachedProbe ??= probeWeasyPrint());

export async function isWeasyPrintAvailable(): Promise<boolean> {
    return (await weasyPrint()).python !== null;
}

// Accepts the UTF-8 bytes the transform Worker returns as well as a plain string —
// Bun's stdin sink writes both, and the render script reads stdin as UTF-8.
export async function htmlToPdf(html: string | Uint8Array): Promise<Buffer> {
    const probe = await weasyPrint();
    if (!probe.python) {
        throw new ApiError(
            501,
            `PDF export requires WeasyPrint ${MIN_WEASYPRINT_MAJOR} or later${probe.found ? `, not ${probe.found}` : ''}. ` +
                'Install it with Homebrew (brew install weasyprint) or with pip in a venv, not pip install --user.',
        );
    }

    // The script's fetcher opens only data: URIs, so nothing in the HTML makes WeasyPrint fetch from the API host.
    const proc = Bun.spawn([probe.python, '-I', renderScript], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 60_000,
    });

    // A WeasyPrint that exits early (bad input) closes its stdin; writing to the dead pipe throws
    // EPIPE. Guard it so an early exit becomes the exitCode-500 below, never a process crash.
    try {
        proc.stdin.write(html);
        await proc.stdin.end();
    } catch {
        // Early stdin close is surfaced by the exitCode/stderr check below.
    }

    const [exitCode, stdoutResponse, stderrResponse] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).text(),
    ]);

    // Only the deadline sends SIGTERM; a render that exited on its own has no signalCode.
    if (proc.signalCode === 'SIGTERM') {
        throw new ApiError(504, 'PDF export timed out');
    }

    if (exitCode !== 0) {
        throw new ApiError(500, `PDF generation failed: ${stderrResponse || `exit code ${exitCode}`}`);
    }

    return Buffer.from(stdoutResponse);
}
