import * as path from 'path';
import * as fs from 'node:fs';
import {isExiftoolExtension} from '@workspace/lib/constants';

export function isExiftoolCandidate(mimeType: string, fileName: string): boolean {
    if (mimeType.startsWith('image/')) return true;
    return isExiftoolExtension(fileName);
}

export async function extractEmbeddedPreview(filePath: string, tmpDir: string, pathId: string): Promise<string | null> {
    try {
        const {exiftool} = await import('exiftool-vendored');
        const extractPath = path.join(tmpDir, `${pathId}-extract.jpg`);

        // Try extractPreview first (larger), then extractJpgFromRaw, then extractThumbnail
        let extracted = await exiftool.extractPreview(filePath, extractPath).catch(() => undefined);
        if (!extracted || !fs.existsSync(extractPath)) {
            extracted = await exiftool.extractJpgFromRaw(filePath, extractPath).catch(() => undefined);
        }
        if (!extracted || !fs.existsSync(extractPath)) {
            extracted = await exiftool.extractThumbnail(filePath, extractPath).catch(() => undefined);
        }

        if (extracted && fs.existsSync(extractPath)) {
            return extractPath;
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
