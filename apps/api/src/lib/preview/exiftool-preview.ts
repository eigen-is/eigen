// The preview a camera or an editor embedded in a file, such as a RAW photo or a PSD, pulled out with exiftool. The
// thumbnail Worker calls extractEmbeddedPreview as its fallback when sharp can't read the file, with a deadline before
// its own end, and the preview and the export ask isExiftoolCandidate whether a file can try it. The binary is the
// system's exiftool, else the one the exiftool-vendored package ships.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { isExiftoolExtension } from '@workspace/lib/constants';

const execFileAsync = promisify(execFile);

export function isExiftoolCandidate(mimeType: string, fileName: string): boolean {
    if (mimeType.startsWith('image/')) return true;
    return isExiftoolExtension(fileName);
}

let cachedExiftoolPath: string | null = null;

async function getExiftoolPath(deadline: number): Promise<string> {
    if (cachedExiftoolPath) return cachedExiftoolPath;

    try {
        // execFile reads a timeout of 0 as none.
        const { stdout } = await execFileAsync('exiftool', ['-ver'], {
            timeout: Math.max(1, deadline - Date.now()),
            killSignal: 'SIGKILL',
        });
        if (stdout.trim()) {
            cachedExiftoolPath = 'exiftool';
            return cachedExiftoolPath;
        }
    } catch {
        /* not installed system-wide */
    }

    const { exiftool } = await import('exiftool-vendored');
    cachedExiftoolPath = await exiftool.exiftoolPath();
    return cachedExiftoolPath;
}

// execFile kills an exiftool still running at `deadline`, a Date.now() time, with SIGKILL, so a hostile file can't keep
// one running. Its timer lives in the caller's thread, which terminate() stops without stopping the child, so the
// deadline must fall before the thread's own end. No call starts after it.
export async function extractEmbeddedPreview(
    filePath: string,
    tmpDir: string,
    pathId: string,
    deadline: number,
): Promise<string | null> {
    try {
        const bin = await getExiftoolPath(deadline);
        const extractPath = path.join(tmpDir, `${pathId}-extract.jpg`);

        // Try PreviewImage (largest), then JpgFromRaw, then ThumbnailImage
        for (const tag of ['-PreviewImage', '-JpgFromRaw', '-ThumbnailImage']) {
            const left = deadline - Date.now();
            if (left <= 0) return null;
            try {
                const { stdout } = await execFileAsync(bin, ['-b', tag, filePath], {
                    encoding: 'buffer',
                    maxBuffer: 20 * 1024 * 1024,
                    timeout: left,
                    killSignal: 'SIGKILL',
                });
                if (stdout && stdout.length > 0) {
                    fs.writeFileSync(extractPath, stdout);
                    return extractPath;
                }
            } catch {
                /* tag not present, try next */
            }
        }

        return null;
    } catch {
        return null;
    }
}

export async function cleanupExtract(extractPath: string): Promise<void> {
    try {
        if (fs.existsSync(extractPath)) {
            fs.unlinkSync(extractPath);
        }
    } catch {
        /* best-effort: a temp file already gone is nothing to clean up */
    }
}
