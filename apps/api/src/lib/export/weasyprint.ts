import { Semaphore } from '../../utils/semaphore';
import { ApiError } from '../core/errors';
import { isEnoent } from '../core/local-filesystem';
import { BUSY_MESSAGE, limitedCommand } from '../document/transform/runner';
import renderScript from './weasyprint-render.py' with { type: 'file' };

// The largest @page side an export asks WeasyPrint for: 200 inches, the PDF page limit. A page sized from
// collaborator data (a huge column width, a drawing element far out) would otherwise cost WeasyPrint
// without bound. Content past it continues on the next page or is cut at the right edge.
export const MAX_PDF_PAGE_PX = 19_200;

// The first with the URLFetcher class weasyprint-render.py subclasses.
const MIN_WEASYPRINT_MAJOR = 68;

const RENDER_TIMEOUT_MS = 60_000;

// A render can take gigabytes, so renders run one at a time, as transform children do (DOCUMENT-TRANSFORMS.md § One
// child runs at a time), beside at most the one child.
const renders = new Semaphore(1);
// A waiting render holds its document and its connection. The runner admits about four foreground exports behind the
// one running (120 s of predicted wait at 30 s each), so four renders may wait behind the one WeasyPrint.
const MAX_WAITING_RENDERS = 4;

type WeasyPrintProbe = { python: string } | { python: null; found: string | null };

let cachedProbe: Promise<WeasyPrintProbe> | null = null;

// The interpreter a launcher's shebang names: `#!/usr/bin/python3`, `#!/usr/bin/env python3`, `#!/usr/bin/env -S
// python3 -X utf8`. pip writes `#!/bin/sh` and an exec line for a long or spaced venv path, so a shebang that names no
// python is no answer.
export function shebangPython(launcherHead: string): string | null {
    const [program, ...args] = (launcherHead.match(/^#!(.*)/)?.[1] ?? '').trim().split(/[ \t]+/);
    const named = program.endsWith('/env') ? args.find((arg) => !arg.startsWith('-') && !arg.includes('=')) : program;
    return named && /^python[\d.]*$/.test(named.slice(named.lastIndexOf('/') + 1)) ? named : null;
}

// The Python that imports a WeasyPrint of at least MIN_WEASYPRINT_MAJOR: the one the `weasyprint` launcher names (a pip
// venv's, Homebrew's own), else python3. `-I` keeps the cwd and the environment off its module path. Else the version
// it found, which the 501 names. An import that hangs is killed, since the export routes set no request timeout, and
// not cached, so the next export probes again.
async function probeWeasyPrint(): Promise<WeasyPrintProbe> {
    const launcher = Bun.which('weasyprint');
    const named = launcher ? shebangPython(await Bun.file(launcher).slice(0, 512).text()) : null;
    let found: string | null = null;
    for (const python of new Set([named ?? 'python3', 'python3'])) {
        try {
            const proc = Bun.spawn([python, '-I', '-c', 'import weasyprint; print(weasyprint.__version__)'], {
                stdout: 'pipe',
                stderr: 'ignore',
                timeout: 5_000,
            });
            const [exitCode, version] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
            if (proc.signalCode === 'SIGTERM') cachedProbe = null;
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

// A cached interpreter can vanish, as a Homebrew upgrade removes the old Cellar path, so a spawn that finds none probes
// once more. The script's fetcher opens only data: URIs, so nothing in the HTML makes WeasyPrint fetch from the API host.
// It runs under the transform child's limits, so the kernel's OOM killer takes it before the API.
async function spawnRender(zoom: number, timeout: number, signal?: AbortSignal) {
    const spawn = async () => {
        const probe = await weasyPrint();
        if (probe.python === null) {
            throw new ApiError(
                501,
                `PDF export requires WeasyPrint ${MIN_WEASYPRINT_MAJOR} or later${probe.found ? `, not ${probe.found}` : ''}. ` +
                    'Install it with Homebrew (brew install weasyprint) or with pip in a venv, not pip install --user.',
            );
        }
        return Bun.spawn(limitedCommand([probe.python, '-I', renderScript, String(zoom)], timeout), {
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            timeout,
            signal,
        });
    };
    try {
        return await spawn();
    } catch (error) {
        if (!isEnoent(error)) throw error;
        cachedProbe = null;
        return spawn();
    }
}

async function render(html: string | Uint8Array, zoom: number, timeout: number, signal?: AbortSignal) {
    const proc = await spawnRender(zoom, timeout, signal);

    // A WeasyPrint that exits early (bad input) closes its stdin; writing to the dead pipe throws
    // EPIPE. Guard it so an early exit becomes the exitCode-500 below, never a process crash.
    try {
        proc.stdin.write(html);
        await proc.stdin.end();
    } catch {
        // Early stdin close is surfaced by the exitCode check below.
    }

    const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).text(),
    ]);
    return { exitCode, signalCode: proc.signalCode, stdout, stderr };
}

// Accepts the UTF-8 bytes the transform process returns as well as a plain string —
// Bun's stdin sink writes both, and the render script reads stdin as UTF-8. `zoom` scales the
// laid-out pages onto their sheets: at 0.5 a 1920 px page prints 960 px, 254 mm, wide. `signal` is the request's: a
// client that is gone kills its render, or leaves the queue of renders waiting their turn.
export async function htmlToPdf(html: string | Uint8Array, zoom = 1, signal?: AbortSignal): Promise<Buffer> {
    if (renders.waiting >= MAX_WAITING_RENDERS) {
        console.warn(`[export] WeasyPrint refused waiting=${renders.waiting}`);
        throw new ApiError(503, BUSY_MESSAGE);
    }
    return renders.run(() => renderPdf(html, zoom, signal), signal);
}

async function renderPdf(html: string | Uint8Array, zoom: number, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    const started = Date.now();
    let result = await render(html, zoom, RENDER_TIMEOUT_MS, signal);

    // WeasyPrint 68 segfaults in a glib thread now and then, and the same HTML renders the next time. One more render,
    // in what is left of the timeout, and none once the first took most of it.
    const left = RENDER_TIMEOUT_MS - (Date.now() - started);
    if (result.signalCode === 'SIGSEGV' && left > RENDER_TIMEOUT_MS / 2 && !signal?.aborted) {
        console.warn('[export] WeasyPrint died of SIGSEGV, rendering once more:', result.stderr);
        result = await render(html, zoom, left, signal);
    }
    signal?.throwIfAborted();

    // Only the deadline sends SIGTERM; a render that exited on its own has no signalCode.
    if (result.signalCode === 'SIGTERM') {
        throw new ApiError(504, 'PDF export timed out');
    }

    // The traceback names the install and the checkout, so it stays in the log.
    if (result.exitCode !== 0) {
        console.error(`[export] WeasyPrint exited with code ${result.exitCode}:`, result.stderr);
        throw new ApiError(500, 'PDF generation failed');
    }

    // WeasyPrint's logger has no handler, so a render that succeeds writes to stderr only when the script falls back.
    if (result.stderr.trim()) console.warn('[export] WeasyPrint:', result.stderr.trim());

    return Buffer.from(result.stdout);
}
