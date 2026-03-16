import * as path from 'path';
import * as fs from 'node:fs';
import {EXIFTOOL_EXTENSIONS} from '@workspace/lib/constants';

const EXIFTOOL_MIMES = new Set([
    'image/x-canon-cr2', 'image/x-canon-cr3', 'image/x-nikon-nef',
    'image/x-sony-arw', 'image/x-adobe-dng', 'image/x-olympus-orf',
    'image/x-panasonic-rw2', 'image/x-fuji-raf', 'image/x-pentax-pef',
    'image/vnd.adobe.photoshop', 'application/photoshop',
    'application/postscript', 'application/illustrator',
    'image/heic', 'image/heif',
]);

export function isExiftoolSupported(mimeType: string, fileName: string): boolean {
    if (EXIFTOOL_MIMES.has(mimeType)) return true;
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    return EXIFTOOL_EXTENSIONS.has(ext);
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
