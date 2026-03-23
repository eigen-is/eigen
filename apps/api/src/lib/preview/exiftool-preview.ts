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
    // Try system exiftool first, fall back to vendored
    try {
        const {stdout} = await execFileAsync('exiftool', ['-ver']);
        if (stdout.trim()) return 'exiftool';
    } catch { /* not installed system-wide */
    }

    const {exiftool} = await import('exiftool-vendored');
    return exiftool.exiftoolPath();
}

export async function extractEmbeddedPreview(filePath: string, tmpDir: string, pathId: string): Promise<string | null> {
    try {
        const bin = await getExiftoolPath();
        console.log(`[exiftool] binary: ${bin}`);
        const extractPath = path.join(tmpDir, `${pathId}-extract.jpg`);

        // Try PreviewImage first (largest), then JpgFromRaw, then ThumbnailImage
        // Use -b to write binary to stdout, then save to file ourselves
        for (const tag of ['-PreviewImage', '-JpgFromRaw', '-ThumbnailImage']) {
            try {
                console.log(`[exiftool] trying ${tag} on ${filePath}`);
                const {stdout} = await execFileAsync(bin, ['-b', tag, filePath], {
                    encoding: 'buffer',
                    maxBuffer: 20 * 1024 * 1024,
                });
                console.log(`[exiftool] ${tag} returned ${stdout?.length ?? 0} bytes`);
                if (stdout && stdout.length > 0) {
                    fs.writeFileSync(extractPath, stdout);
                    return extractPath;
                }
            } catch (e: any) {
                console.log(`[exiftool] ${tag} failed: ${e.message?.split('\n')[0]}`);
            }
        }

        console.log(`[exiftool] no preview found for ${filePath}`);
        return null;
    } catch (e: any) {
        console.log(`[exiftool] error: ${e.message}`);
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
