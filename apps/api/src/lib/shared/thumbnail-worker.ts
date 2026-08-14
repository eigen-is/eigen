import * as path from 'node:path';
import sharp from 'sharp';
import { cleanupExtract, extractEmbeddedPreview } from '../preview/exiftool-preview';
import { extractVideoFrame } from './video-thumbnail';

type WorkerInput = {
    source: string | ArrayBuffer;
    mimeType: string;
    fileName: string;
    tmpDir: string;
    pathId: string;
    options: { maxSize: number; quality: number; fit: 'inside' | 'cover' };
};

type WorkerOutput = { ok: true; data: ArrayBuffer; width: number; height: number; duration?: number } | { ok: false };

type ImageResult = { data: Buffer; width: number; height: number; duration?: number };

async function sharpResize(
    source: Buffer | string,
    options: { maxSize: number; quality: number; fit: 'inside' | 'cover' },
): Promise<ImageResult | null> {
    try {
        const image = sharp(source, { animated: true });
        const metadata = await image.metadata();

        if (!metadata.width || !metadata.height) return null;

        const rotated = metadata.orientation && metadata.orientation >= 5;
        const width = rotated ? metadata.pageHeight || metadata.height! : metadata.width;
        const height = rotated ? metadata.width : metadata.pageHeight || metadata.height!;

        if (width > 32000 || height > 32000) return null;

        const data = await image
            .rotate()
            .resize(options.maxSize, options.maxSize, {
                fit: options.fit,
                position: 'center',
                withoutEnlargement: options.fit === 'inside',
            })
            .webp({ quality: options.quality })
            .toBuffer();

        return { data, width, height };
    } catch {
        return null;
    }
}

async function heicToJpeg(source: Buffer | string): Promise<Buffer | null> {
    try {
        // @ts-expect-error -- no type declarations available for heic-convert
        const convert = (await import('heic-convert')).default as (opts: {
            buffer: Buffer;
            format: string;
            quality: number;
        }) => Promise<ArrayBuffer>;
        const buffer = typeof source === 'string' ? Buffer.from(await Bun.file(source).arrayBuffer()) : source;
        const output = await convert({ buffer, format: 'JPEG', quality: 0.8 });
        return Buffer.from(output);
    } catch {
        return null;
    }
}

async function processImage(input: WorkerInput): Promise<ImageResult | null> {
    const source = typeof input.source === 'string' ? input.source : Buffer.from(input.source);

    const result = await sharpResize(source, input.options);
    if (result) return result;

    if (input.mimeType === 'image/heic' || input.mimeType === 'image/heif') {
        const jpeg = await heicToJpeg(source);
        if (jpeg) {
            const converted = await sharpResize(jpeg, input.options);
            if (converted) return converted;
        }
    }

    // Exiftool fallback — needs a file on disk
    let filePath: string;
    let tempFile: string | null = null;

    if (typeof source === 'string') {
        filePath = source;
    } else {
        tempFile = path.join(input.tmpDir, `${input.pathId}-src.tmp`);
        await Bun.write(tempFile, source);
        filePath = tempFile;
    }

    try {
        const extractPath = await extractEmbeddedPreview(filePath, input.tmpDir, input.pathId);
        if (!extractPath) return null;

        try {
            return await sharpResize(extractPath, input.options);
        } finally {
            await cleanupExtract(extractPath);
        }
    } finally {
        if (tempFile) await cleanupExtract(tempFile);
    }
}

async function processVideo(input: WorkerInput): Promise<ImageResult | null> {
    // v1: video thumbnails only generated when the source is a local file path.
    // Upload-time always satisfies this (mount.getTempPath). S3-stored regeneration
    // would require streaming to a temp file first; out of scope for v1.
    if (typeof input.source !== 'string') return null;

    const frame = await extractVideoFrame(input.source, input.tmpDir, input.pathId);
    if (!frame) return null;

    const resized = await sharpResize(frame.data, input.options);
    if (!resized) return null;

    return { ...resized, duration: frame.duration };
}

declare var self: Worker;

self.onmessage = async (event: MessageEvent<WorkerInput>) => {
    try {
        const result = event.data.mimeType.startsWith('video/')
            ? await processVideo(event.data)
            : await processImage(event.data);
        if (result) {
            const ab = result.data.buffer.slice(
                result.data.byteOffset,
                result.data.byteOffset + result.data.byteLength,
            ) as ArrayBuffer;
            const payload: WorkerOutput = {
                ok: true,
                data: ab,
                width: result.width,
                height: result.height,
                ...(result.duration !== undefined && { duration: result.duration }),
            };
            postMessage(payload, [ab]);
        } else {
            postMessage({ ok: false } satisfies WorkerOutput);
        }
    } catch (e) {
        console.error(`[thumbnail-worker] Failed for ${event.data.pathId}:`, e);
        postMessage({ ok: false } satisfies WorkerOutput);
    }
};
