import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ImageDimensions } from '@workspace/lib/types/drive';
import type { BunFile } from 'bun';
import { isExiftoolCandidate } from '../preview/exiftool-preview';
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

export async function generateImagePreview(
    source: ImageSource,
    mimeType: string,
    fileName: string,
    tmpDir: string,
    pathId: string,
    options?: ThumbnailOptions,
): Promise<ImageResult | null> {
    if (!isExiftoolCandidate(mimeType, fileName)) return null;

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

    return new Promise((resolve) => {
        const worker = new Worker(new URL('./thumbnail-worker.ts', import.meta.url).href);

        worker.onmessage = (event: MessageEvent) => {
            worker.terminate();
            if (!event.data.ok) {
                resolve(null);
                return;
            }
            resolve({
                data: Buffer.from(event.data.data),
                width: event.data.width,
                height: event.data.height,
            });
        };

        worker.onerror = (err) => {
            console.error(`[thumbnail-worker] Error for ${pathId}:`, err);
            worker.terminate();
            resolve(null);
        };

        const message = { source: resolvedSource, mimeType, fileName, tmpDir, pathId, options: opts };

        if (resolvedSource instanceof ArrayBuffer) {
            worker.postMessage(message, [resolvedSource]);
        } else {
            worker.postMessage(message);
        }
    });
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

export async function getThumbnail(thumbsDir: string, pathId: string): Promise<BunFile | null> {
    try {
        const file = Bun.file(getThumbnailPath(thumbsDir, pathId));
        if (await file.exists()) return file;
    } catch {}

    return null;
}
