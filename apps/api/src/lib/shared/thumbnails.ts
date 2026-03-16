import type {BunFile} from 'bun';
import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'node:fs';
import {cleanupExtract, extractEmbeddedPreview, isExiftoolSupported} from '../preview/exiftool-preview';

export type ThumbnailOptions = {
    maxSize?: number;
    quality?: number;
    format?: 'webp' | 'jpeg';
    fit?: 'inside' | 'cover';
};

const DEFAULT_OPTIONS: Required<ThumbnailOptions> = {
    maxSize: 512,
    quality: 80,
    format: 'webp',
    fit: 'inside'
};

const THUMBNAIL_SUPPORTED_MIMES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/bmp',
    'image/tiff'
];

export function isThumbnailSupported(mimeType: string): boolean {
    return THUMBNAIL_SUPPORTED_MIMES.some(mime => mimeType.startsWith(mime.split('/')[0] + '/'));
}

export async function generateThumbnail(
    source: BunFile | Buffer | string,
    mimeType: string,
    options?: ThumbnailOptions
): Promise<Buffer | null> {
    if (!isThumbnailSupported(mimeType)) {
        return null;
    }

    const opts = {...DEFAULT_OPTIONS, ...options};

    try {
        let image: sharp.Sharp;

        if (typeof source === 'string') {
            image = sharp(source);
        } else if (Buffer.isBuffer(source)) {
            image = sharp(source);
        } else {
            image = sharp(Buffer.from(await source.arrayBuffer()));
        }
        const metadata = await image.metadata();

        if (!metadata.width || !metadata.height) {
            return null;
        }

        if (metadata.width > 12000 || metadata.height > 12000) {
            return null;
        }

        const resized = image.resize(opts.maxSize, opts.maxSize, {
            fit: opts.fit,
            position: 'center',
            withoutEnlargement: opts.fit === 'inside'
        });

        if (opts.format === 'webp') {
            return await resized.webp({quality: opts.quality}).toBuffer();
        } else {
            return await resized.jpeg({quality: opts.quality}).toBuffer();
        }
    } catch (error) {
        // console.error('Failed to generate thumbnail:', error);
        return null;
    }
}

export function getThumbnailPath(thumbsDir: string, pathId: string, format: 'webp' | 'jpeg' = 'webp'): string {
    return path.join(thumbsDir, `${pathId}.${format}`);
}

export async function saveThumbnail(
    thumbsDir: string,
    pathId: string,
    source: BunFile | Buffer | string,
    mimeType: string,
    options?: ThumbnailOptions & { fileName?: string }
): Promise<string | null> {
    const opts = {...DEFAULT_OPTIONS, ...options};

    let thumbData = await generateThumbnail(source, mimeType, opts);

    // If sharp can't handle it, try exiftool extraction for RAW/PSD/AI
    if (!thumbData && opts.fileName && isExiftoolSupported(mimeType, opts.fileName)) {
        try {
            const sourcePath = typeof source === 'string' ? source : null;
            if (sourcePath) {
                const extractPath = await extractEmbeddedPreview(sourcePath, thumbsDir, `${pathId}-tmp`);
                if (extractPath) {
                    thumbData = await generateThumbnail(extractPath, 'image/jpeg', opts);
                    await cleanupExtract(extractPath);
                }
            }
        } catch {
        }
    }

    if (!thumbData) {
        return null;
    }

    if (!fs.existsSync(thumbsDir)) {
        fs.mkdirSync(thumbsDir, {recursive: true});
    }

    const thumbPath = getThumbnailPath(thumbsDir, pathId, opts.format);
    await Bun.write(thumbPath, thumbData);

    return `${pathId}.${opts.format}`;
}

export {isExiftoolSupported} from '../preview/exiftool-preview';

export async function extractImageDetails(
    source: Buffer,
    mimeType: string
): Promise<{ width: number; height: number } | null> {
    if (!isThumbnailSupported(mimeType)) {
        return null;
    }

    try {
        const metadata = await sharp(source).metadata();
        if (metadata.width && metadata.height) {
            return {width: metadata.width, height: metadata.height};
        }
    } catch {
    }
    return null;
}

export async function deleteThumbnail(thumbsDir: string, pathId: string): Promise<void> {
    const webpPath = getThumbnailPath(thumbsDir, pathId, 'webp');
    const jpegPath = getThumbnailPath(thumbsDir, pathId, 'jpeg');

    try {
        const webpFile = Bun.file(webpPath);
        if (await webpFile.exists()) {
            await webpFile.delete();
        }
    } catch {
    }

    try {
        const jpegFile = Bun.file(jpegPath);
        if (await jpegFile.exists()) {
            await jpegFile.delete();
        }
    } catch {
    }
}

export async function getThumbnail(thumbsDir: string, pathId: string): Promise<Buffer | null> {
    const webpPath = getThumbnailPath(thumbsDir, pathId, 'webp');
    const jpegPath = getThumbnailPath(thumbsDir, pathId, 'jpeg');

    try {
        const webpFile = Bun.file(webpPath);
        if (await webpFile.exists()) {
            return Buffer.from(await webpFile.arrayBuffer());
        }

        const jpegFile = Bun.file(jpegPath);
        if (await jpegFile.exists()) {
            return Buffer.from(await jpegFile.arrayBuffer());
        }
    } catch {
    }

    return null;
}
