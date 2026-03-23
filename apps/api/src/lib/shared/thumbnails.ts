import type {BunFile} from 'bun';
import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'node:fs';
import {cleanupExtract, extractEmbeddedPreview, isExiftoolCandidate} from '../preview/exiftool-preview';
import type {ImageDimensions} from '@workspace/lib/types/drive';

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

export type ImageResult = ImageDimensions & {
    data: Buffer;
};

async function sharpResize(
    source: BunFile | Buffer | string,
    options?: ThumbnailOptions
): Promise<ImageResult | null> {
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

        if (!metadata.width || !metadata.height) return null;
        if (metadata.width > 12000 || metadata.height > 12000) return null;

        const {width, height} = metadata;

        const resized = image.resize(opts.maxSize, opts.maxSize, {
            fit: opts.fit,
            position: 'center',
            withoutEnlargement: opts.fit === 'inside'
        });

        const data = opts.format === 'webp'
            ? await resized.webp({quality: opts.quality}).toBuffer()
            : await resized.jpeg({quality: opts.quality}).toBuffer();

        return {data, width, height};
    } catch {
        return null;
    }
}

async function heicToJpeg(source: BunFile | Buffer | string): Promise<Buffer | null> {
    try {
        // @ts-ignore -- no type declarations available for heic-convert
        const convert = (await import('heic-convert')).default as (opts: {
            buffer: Buffer;
            format: string;
            quality: number
        }) => Promise<ArrayBuffer>;
        let buffer: Buffer;
        if (typeof source === 'string') {
            buffer = Buffer.from(await Bun.file(source).arrayBuffer());
        } else if (Buffer.isBuffer(source)) {
            buffer = source;
        } else {
            buffer = Buffer.from(await source.arrayBuffer());
        }
        const output = await convert({buffer, format: 'JPEG', quality: 0.8});
        return Buffer.from(output);
    } catch {
        return null;
    }
}

export async function generateImagePreview(
    source: BunFile | Buffer | string,
    mimeType: string,
    fileName: string,
    tmpDir: string,
    pathId: string,
    options?: ThumbnailOptions
): Promise<ImageResult | null> {
    if (!isExiftoolCandidate(mimeType, fileName)) return null;

    console.log(`[thumbnail] ${fileName} (${mimeType}) — trying sharp`);
    // Try sharp first — handles JPEG, PNG, WebP, GIF, TIFF, and HEIC (if libvips supports it)
    const result = await sharpResize(source, options);
    if (result) {
        console.log(`[thumbnail] ${fileName} — sharp succeeded`);
        return result;
    }
    console.log(`[thumbnail] ${fileName} — sharp failed`);

    // Sharp failed on HEIC — convert to JPEG first, then resize
    if (mimeType === 'image/heic' || mimeType === 'image/heif') {
        const jpeg = await heicToJpeg(source);
        if (jpeg) {
            const converted = await sharpResize(jpeg, options);
            if (converted) return converted;
        }
    }

    // Sharp + HEIC conversion both failed — try exiftool (needs a file on disk)
    let filePath: string;
    let tempFile: string | null = null;

    if (typeof source === 'string') {
        filePath = source;
    } else {
        tempFile = path.join(tmpDir, `${pathId}-src.tmp`);
        const data = Buffer.isBuffer(source) ? source : Buffer.from(await source.arrayBuffer());
        await Bun.write(tempFile, data);
        filePath = tempFile;
    }

    try {
        const extractPath = await extractEmbeddedPreview(filePath, tmpDir, pathId);
        if (!extractPath) return null;

        try {
            return await sharpResize(extractPath, options);
        } finally {
            await cleanupExtract(extractPath);
        }
    } finally {
        if (tempFile) await cleanupExtract(tempFile);
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
    fileName: string,
    options?: ThumbnailOptions
): Promise<(ImageResult & { fileName: string }) | null> {
    const opts = {...DEFAULT_OPTIONS, ...options};

    const result = await generateImagePreview(source, mimeType, fileName, thumbsDir, pathId, opts);
    if (!result) return null;

    if (!fs.existsSync(thumbsDir)) {
        fs.mkdirSync(thumbsDir, {recursive: true});
    }

    const thumbPath = getThumbnailPath(thumbsDir, pathId, opts.format);
    await Bun.write(thumbPath, result.data);

    return {...result, fileName: `${pathId}.${opts.format}`};
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
