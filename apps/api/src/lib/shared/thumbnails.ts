import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImageDimensions } from '@workspace/lib/types/drive';
import type { BunFile } from 'bun';
import { Semaphore } from '../../utils/semaphore';
import { isExiftoolCandidate } from '../preview/exiftool-preview';
import { isVideoCandidate } from '../preview/video-preview';
import type { StorageFile } from '../storage';

// Each generateImagePreview spawns a Worker that loads sharp; export/media.ts fans out
// Promise.all over every media file. Cap concurrent workers so a large export can't spawn N
// sharp-loading workers at once and exhaust memory.
const imageWorkerSemaphore = new Semaphore(4);

type ImageSource = StorageFile | Buffer | string;

type ThumbnailOptions = {
    maxSize?: number;
    quality?: number;
    fit?: 'inside' | 'cover';
    format?: 'webp' | 'jpeg' | 'png' | 'gif';
};

const DEFAULT_OPTIONS: Required<ThumbnailOptions> = {
    maxSize: 512,
    quality: 80,
    fit: 'inside',
    format: 'webp',
};

type ImageResult = ImageDimensions & {
    data: Buffer;
    hasAlpha: boolean;
    frameCount: number;
    duration?: number;
};

export async function generateImagePreview(
    source: ImageSource,
    mimeType: string,
    fileName: string,
    tmpDir: string,
    pathId: string,
    options?: ThumbnailOptions,
): Promise<ImageResult | null> {
    if (!isExiftoolCandidate(mimeType, fileName) && !isVideoCandidate(mimeType)) return null;

    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Resolve source for transfer to the worker:
    // - String paths and BunFile paths are passed as-is — worker/sharp reads from disk (zero-copy)
    // - S3File/Buffer → arrayBuffer for zero-copy transfer via postMessage
    let resolvedSource: string | ArrayBuffer;
    if (typeof source === 'string') {
        resolvedSource = source;
    } else if (Buffer.isBuffer(source)) {
        resolvedSource = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
    } else if (!('bucket' in source) && source.name) {
        // BunFile — pass its local file path so the worker/sharp can read directly from disk
        resolvedSource = source.name;
    } else {
        // S3File — download to buffer, transfer zero-copy to worker
        resolvedSource = await source.arrayBuffer();
    }

    if (tmpDir) {
        fs.mkdirSync(tmpDir, { recursive: true });
    }

    return imageWorkerSemaphore.run(
        () =>
            new Promise<ImageResult | null>((resolve) => {
                const worker = new Worker(new URL('./thumbnail-worker', import.meta.url).href);

                const cleanup = () => {
                    clearTimeout(timeout);
                    worker.terminate();
                };

                const timeout = setTimeout(() => {
                    console.error(`[thumbnail-worker] Timeout for ${pathId}`);
                    cleanup();
                    resolve(null);
                }, 30_000);

                worker.onmessage = (event: MessageEvent) => {
                    cleanup();
                    if (!event.data.ok) {
                        resolve(null);
                        return;
                    }
                    resolve({
                        data: Buffer.from(event.data.data),
                        width: event.data.width,
                        height: event.data.height,
                        hasAlpha: !!event.data.hasAlpha,
                        frameCount: event.data.frameCount ?? 1,
                        ...(event.data.duration !== undefined && { duration: event.data.duration }),
                    });
                };

                worker.onerror = (err) => {
                    console.error(`[thumbnail-worker] Error for ${pathId}:`, err);
                    cleanup();
                    resolve(null);
                };

                const message = { source: resolvedSource, mimeType, fileName, tmpDir, pathId, options: opts };

                if (resolvedSource instanceof ArrayBuffer) {
                    worker.postMessage(message, [resolvedSource]);
                } else {
                    worker.postMessage(message);
                }
            }),
    );
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

export async function getThumbnail(thumbsDir: string, pathId: string): Promise<BunFile | null> {
    try {
        const file = Bun.file(getThumbnailPath(thumbsDir, pathId));
        if (await file.exists()) return file;
    } catch {}

    return null;
}
