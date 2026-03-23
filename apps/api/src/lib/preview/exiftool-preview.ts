import * as path from 'path';
import * as fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isExiftoolExtension} from '@workspace/lib/constants';

const execFileAsync = promisify(execFile);

export function isExiftoolCandidate(mimeType: string, fileName: string): boolean {
    if (mimeType.startsWith('image/')) return true;
    return isExiftoolExtension(fileName);
}

async function getExiftoolPath(): Promise<string> {
    const {exiftool} = await import('exiftool-vendored');
    return exiftool.exiftoolPath();
}

export async function extractEmbeddedPreview(filePath: string, tmpDir: string, pathId: string): Promise<string | null> {
    try {
        const bin = await getExiftoolPath();
        const extractPath = path.join(tmpDir, `${pathId}-extract.jpg`);

        // Try PreviewImage first (largest), then JpgFromRaw, then ThumbnailImage
        for (const tag of ['-PreviewImage', '-JpgFromRaw', '-ThumbnailImage']) {
            try {
                await execFileAsync(bin, ['-b', tag, '-W', extractPath, filePath]);
                if (fs.existsSync(extractPath) && fs.statSync(extractPath).size > 0) {
                    return extractPath;
                }
            } catch { /* tag not present, try next */
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
