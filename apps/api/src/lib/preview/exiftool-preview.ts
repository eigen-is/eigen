import {execFile} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {isExiftoolExtension} from '@workspace/lib/constants';

const execFileAsync = promisify(execFile);

export function isExiftoolCandidate(mimeType: string, fileName: string): boolean {
    if (mimeType.startsWith('image/')) return true;
    return isExiftoolExtension(fileName);
}

let cachedExiftoolPath: string | null = null;

async function getExiftoolPath(): Promise<string> {
    if (cachedExiftoolPath) return cachedExiftoolPath;

    // Try system exiftool first, fall back to vendored
    try {
        const {stdout} = await execFileAsync('exiftool', ['-ver']);
        if (stdout.trim()) {
            cachedExiftoolPath = 'exiftool';
            return cachedExiftoolPath;
        }
    } catch {
        /* not installed system-wide */
    }

    const {exiftool} = await import('exiftool-vendored');
    cachedExiftoolPath = await exiftool.exiftoolPath();
    return cachedExiftoolPath;
}

export async function extractEmbeddedPreview(filePath: string, tmpDir: string, pathId: string): Promise<string | null> {
    try {
        const bin = await getExiftoolPath();
        const extractPath = path.join(tmpDir, `${pathId}-extract.jpg`);

        // Try PreviewImage (largest), then JpgFromRaw, then ThumbnailImage
        for (const tag of ['-PreviewImage', '-JpgFromRaw', '-ThumbnailImage']) {
            try {
                const {stdout} = await execFileAsync(bin, ['-b', tag, filePath], {
                    encoding: 'buffer',
                    maxBuffer: 20 * 1024 * 1024,
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
    }
}
