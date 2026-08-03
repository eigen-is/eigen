import { ApiError } from '../core/errors';

let cachedAvailable: boolean | null = null;

export async function isWeasyPrintAvailable(): Promise<boolean> {
    if (cachedAvailable !== null) return cachedAvailable;

    try {
        const proc = Bun.spawn(['weasyprint', '--version'], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
        await proc.exited;
        cachedAvailable = proc.exitCode === 0;
    } catch {
        cachedAvailable = false;
    }

    return cachedAvailable;
}

// Accepts the UTF-8 bytes the transform Worker returns as well as a plain string —
// Bun's stdin sink writes both, and weasyprint already reads `--encoding utf-8`.
export async function htmlToPdf(html: string | Uint8Array): Promise<Buffer> {
    if (!(await isWeasyPrintAvailable())) {
        throw new ApiError(501, 'PDF export requires WeasyPrint. Install with: pip install weasyprint');
    }

    // SSRF is closed upstream in sanitizeExportHtml (export/sanitize.ts), which strips every non-data:
    // url()/img src before the HTML reaches here — WeasyPrint's CLI can't restrict fetch protocols.
    const proc = Bun.spawn(['weasyprint', '-', '-', '--encoding', 'utf-8'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
    });

    const timeout = 60_000;
    const timer = setTimeout(() => {
        proc.kill();
    }, timeout);

    try {
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

        if (exitCode === null) {
            throw new ApiError(504, 'PDF export timed out');
        }

        if (exitCode !== 0) {
            throw new ApiError(500, `PDF generation failed: ${stderrResponse || `exit code ${exitCode}`}`);
        }

        return Buffer.from(stdoutResponse);
    } finally {
        clearTimeout(timer);
    }
}
