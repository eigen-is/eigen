import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ImageDimensions } from '@workspace/lib/types/drive';
import { cleanupExtract, extractEmbeddedPreview } from '../preview/exiftool-preview';
import { sharpResize } from './sharp-resize';
import { extractVideoFrame } from './video-thumbnail';

export type ThumbnailFormat = 'webp' | 'jpeg' | 'png' | 'gif';

// The postMessage protocol with thumbnails.ts, which imports these type-only — the worker module (and its
// sharp import) never loads on the main thread.
export type WorkerInput = {
    source: string | ArrayBuffer;
    mimeType: string;
    fileName: string;
    tmpDir: string;
    pathId: string;
    options: { maxSize: number; quality: number; fit: 'inside' | 'cover'; format: ThumbnailFormat };
};

export type WorkerOutput =
    | {
          ok: true;
          data: ArrayBuffer;
          width: number;
          height: number;
          hasAlpha: boolean;
          frameCount: number;
          duration?: number;
      }
    | { ok: false };

export type ImageResult = ImageDimensions & {
    data: Buffer;
    hasAlpha: boolean;
    frameCount: number;
    duration?: number;
};

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

    // Exiftool fallback — needs a file on disk. Avatar conversions pass no tmpDir, and their scratch names
    // are derived from a fixed pathId: without a private dir they collide in the process CWD, so concurrent
    // conversions would read each other's bytes.
    const scratchDir = input.tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'eigen-thumb-'));
    let tempFile: string | null = null;

    try {
        let filePath: string;
        if (typeof source === 'string') {
            filePath = source;
        } else {
            tempFile = path.join(scratchDir, `${input.pathId}-src.tmp`);
            await Bun.write(tempFile, source);
            filePath = tempFile;
        }

        const extractPath = await extractEmbeddedPreview(filePath, scratchDir, input.pathId);
        if (!extractPath) return null;

        try {
            return await sharpResize(extractPath, input.options);
        } finally {
            await cleanupExtract(extractPath);
        }
    } finally {
        if (tempFile) await cleanupExtract(tempFile);
        if (scratchDir !== input.tmpDir) fs.rmSync(scratchDir, { recursive: true, force: true });
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
                hasAlpha: result.hasAlpha,
                frameCount: result.frameCount,
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
