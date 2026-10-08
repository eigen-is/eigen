import { ApiError } from '../core/errors';
import renderScript from './weasyprint-render.py' with { type: 'file' };

// The largest @page side an export asks WeasyPrint for: 200 inches, the PDF page limit. A page sized from
// collaborator data (a huge column width, a drawing element far out) would otherwise cost WeasyPrint
// without bound. Content past it continues on the next page or is cut at the right edge.
export const MAX_PDF_PAGE_PX = 19_200;

let cachedPython: Promise<string | null> | null = null;

// The Python that imports weasyprint: the one the `weasyprint` launcher names (Debian's /usr/bin/python3, a pip venv's,
// Homebrew's own), else python3. `-I` keeps the cwd and the environment off its module path.
async function findWeasyPrintPython(): Promise<string | null> {
    const launcher = Bun.which('weasyprint');
    const shebang = launcher
        ? (await Bun.file(launcher).slice(0, 512).text()).match(/^#![ \t]*(\S+)(?:[ \t]+(\S+))?/)
        : null;
    const named = shebang?.[1].endsWith('/env') ? shebang[2] : shebang?.[1];
    for (const python of new Set([named, 'python3'])) {
        if (!python) continue;
        try {
            const proc = Bun.spawn([python, '-I', '-c', 'import weasyprint'], { stdout: 'ignore', stderr: 'ignore' });
            if ((await proc.exited) === 0) return python;
        } catch {
            // Not installed: try the next one.
        }
    }
    return null;
}

const weasyPrintPython = (): Promise<string | null> => (cachedPython ??= findWeasyPrintPython());

export async function isWeasyPrintAvailable(): Promise<boolean> {
    return (await weasyPrintPython()) !== null;
}

// Accepts the UTF-8 bytes the transform Worker returns as well as a plain string —
// Bun's stdin sink writes both, and the render script reads stdin as UTF-8.
export async function htmlToPdf(html: string | Uint8Array): Promise<Buffer> {
    const python = await weasyPrintPython();
    if (!python) {
        throw new ApiError(501, 'PDF export requires WeasyPrint. Install with: pip install weasyprint');
    }

    // The script's fetcher opens only data: URIs, so nothing in the HTML makes WeasyPrint fetch from the API host.
    const proc = Bun.spawn([python, '-I', renderScript], {
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
