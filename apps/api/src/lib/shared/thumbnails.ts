import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImageDimensions } from '@workspace/lib/types/drive';
import sharp from 'sharp';
import { cleanupExtract, extractEmbeddedPreview, isExiftoolCandidate } from '../preview/exiftool-preview';
import type { StorageFile } from '../storage';

type ImageSource = StorageFile | Buffer | string;

type ThumbnailOptions = {
    maxSize?: number;
    quality?: number;
    fit?: 'inside' | 'cover';
};

const DEFAULT_OPTIONS: Required<ThumbnailOptions> = {
    maxSize: 512,
    quality: 80,
    fit: 'inside',
};

type ImageResult = ImageDimensions & {
    data: Buffer;
};

async function toBuffer(source: ImageSource): Promise<Buffer> {
    if (Buffer.isBuffer(source)) return source;
    if (typeof source === 'string') return Buffer.from(await Bun.file(source).arrayBuffer());
    return Buffer.from(await source.arrayBuffer());
}

async function sharpResize(source: ImageSource, options?: ThumbnailOptions): Promise<ImageResult | null> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    try {
        // sharp accepts file paths directly (zero-copy) or Buffers
        const image = typeof source === 'string' ? sharp(source) : sharp(await toBuffer(source));
        const metadata = await image.metadata();

        if (!metadata.width || !metadata.height) return null;
        if (metadata.width > 12000 || metadata.height > 12000) return null;

        const { width, height } = metadata;

        const resized = image.resize(opts.maxSize, opts.maxSize, {
            fit: opts.fit,
            position: 'center',
            withoutEnlargement: opts.fit === 'inside',
        });

        const data = await resized.webp({ quality: opts.quality }).toBuffer();

        return { data, width, height };
    } catch {
        return null;
    }
}

async function heicToJpeg(source: ImageSource): Promise<Buffer | null> {
    try {
        // @ts-expect-error -- no type declarations available for heic-convert
        const convert = (await import('heic-convert')).default as (opts: {
            buffer: Buffer;
            format: string;
            quality: number;
        }) => Promise<ArrayBuffer>;
        const buffer = await toBuffer(source);
        const output = await convert({ buffer, format: 'JPEG', quality: 0.8 });
        return Buffer.from(output);
    } catch {
        return null;
    }
}

export async function generateImagePreview(
    source: ImageSource,
    mimeType: string,
    fileName: string,
    tmpDir: string,
    pathId: string,
    options?: ThumbnailOptions,
): Promise<ImageResult | null> {
    if (!isExiftoolCandidate(mimeType, fileName)) return null;

    // Try sharp first — handles JPEG, PNG, WebP, GIF, TIFF, and HEIC (if libvips supports it)
    const result = await sharpResize(source, options);
    if (result) return result;

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
        await Bun.write(tempFile, await toBuffer(source));
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

function getThumbnailPath(thumbsDir: string, pathId: string): string {
    return path.join(thumbsDir, `${pathId}.webp`);
}

export async function saveThumbnail(
    thumbsDir: string,
    pathId: string,
    source: ImageSource,
    mimeType: string,
    fileName: string,
    options?: ThumbnailOptions,
): Promise<(ImageResult & { fileName: string }) | null> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    const result = await generateImagePreview(source, mimeType, fileName, thumbsDir, pathId, opts);
    if (!result) return null;

    if (!fs.existsSync(thumbsDir)) {
        fs.mkdirSync(thumbsDir, { recursive: true });
    }

    const thumbPath = getThumbnailPath(thumbsDir, pathId);
    await Bun.write(thumbPath, result.data);

    return { ...result, fileName: `${pathId}.webp` };
}

export async function deleteThumbnail(thumbsDir: string, pathId: string): Promise<void> {
    try {
        const file = Bun.file(getThumbnailPath(thumbsDir, pathId));
        if (await file.exists()) {
            await file.delete();
        }
    } catch {}
}

export async function getThumbnail(thumbsDir: string, pathId: string): Promise<Buffer | null> {
    try {
        const file = Bun.file(getThumbnailPath(thumbsDir, pathId));
        if (await file.exists()) {
            return Buffer.from(await file.arrayBuffer());
        }
    } catch {}

    return null;
}
