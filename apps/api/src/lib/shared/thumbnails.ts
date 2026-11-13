// Resized copies of an image or a video, made off the event loop. generateImagePreview runs one thumbnail Worker per
// picture, for callers such as the screen preview, an avatar or an export. saveThumbnail makes the small still a Drive
// file keeps in its mount's thumbnails folder after an upload or an overwrite, and the rest copy, read and delete it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BunFile } from 'bun';
import { Semaphore } from '../../utils/semaphore';
import { isExiftoolCandidate } from '../preview/exiftool-preview';
import { isVideoCandidate } from '../preview/video-preview';
import type { StorageFile } from '../storage';
import { readStorageFile } from '../storage';
import { THUMBNAIL_TIMEOUT_SECONDS } from './thumbnail-timeout';
import type { ImageResult, WorkerInput, WorkerOutput } from './thumbnail-worker';

// Every Worker loads its own sharp, and an export asks for all of its media at once. The cap keeps a large export
// from starting a Worker per picture and running out of memory.
const imageWorkerSemaphore = new Semaphore(4);

type ImageSource = StorageFile | Buffer | string;

const DEFAULT_OPTIONS: WorkerInput['options'] = {
    maxSize: 512,
    quality: 80,
    fit: 'inside',
    format: 'webp',
};

export async function generateImagePreview(
    source: ImageSource,
    mimeType: string,
    fileName: string,
    tmpDir: string,
    pathId: string,
    options?: Partial<WorkerInput['options']>,
): Promise<ImageResult | null> {
    if (!isExiftoolCandidate(mimeType, fileName) && !isVideoCandidate(mimeType)) return null;

    // A file on local disk goes to the Worker as its path, so sharp reads it there. Bytes in memory, and an S3 object
    // read into memory, go as an ArrayBuffer that postMessage hands over rather than copies. A Buffer is copied into
    // one of its own first, because it may share its memory with other Buffers.
    let resolvedSource: string | ArrayBuffer;
    if (typeof source === 'string') {
        resolvedSource = source;
    } else if (Buffer.isBuffer(source)) {
        resolvedSource = new Uint8Array(source).buffer;
    } else if (!('bucket' in source) && source.name) {
        resolvedSource = source.name;
    } else {
        resolvedSource = await readStorageFile(source);
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
                }, THUMBNAIL_TIMEOUT_SECONDS * 1000);

                worker.onmessage = (event: MessageEvent<WorkerOutput>) => {
                    cleanup();
                    if (!event.data.ok) {
                        resolve(null);
                        return;
                    }
                    resolve({
                        data: Buffer.from(event.data.data),
                        width: event.data.width,
                        height: event.data.height,
                        hasAlpha: event.data.hasAlpha,
                        frameCount: event.data.frameCount,
                        ...(event.data.duration !== undefined && { duration: event.data.duration }),
                    });
                };

                worker.onerror = (err) => {
                    console.error(`[thumbnail-worker] Error for ${pathId}:`, err);
                    cleanup();
                    resolve(null);
                };

                const message: WorkerInput = {
                    source: resolvedSource,
                    mimeType,
                    fileName,
                    tmpDir,
                    pathId,
                    options: { ...DEFAULT_OPTIONS, ...options },
                };

                if (resolvedSource instanceof ArrayBuffer) {
                    worker.postMessage(message, [resolvedSource]);
                } else {
                    worker.postMessage(message);
                }
            }),
    );
}

export async function saveThumbnail(
    thumbsDir: string,
    pathId: string,
    source: ImageSource,
    mimeType: string,
    fileName: string,
): Promise<(ImageResult & { fileName: string }) | null> {
    // A Drive thumbnail is a still, so a grid of GIFs doesn't play. The screen preview keeps the animation.
    const result = await generateImagePreview(source, mimeType, fileName, thumbsDir, pathId, { still: true });
    if (!result) return null;

    await Bun.write(thumbnailPath(thumbsDir, pathId), result.data);
    return { ...result, fileName: thumbnailFileName(pathId) };
}

// Returns the new thumbnail's file name, or null when the source row is stale and its file is gone.
export async function copyThumbnail(
    sourceDir: string,
    sourceFileName: string,
    thumbsDir: string,
    pathId: string,
): Promise<string | null> {
    const source = Bun.file(path.join(sourceDir, sourceFileName));
    if (!(await source.exists())) return null;
    await Bun.write(thumbnailPath(thumbsDir, pathId), source);
    return thumbnailFileName(pathId);
}

// Part of deleting a file, so a thumbnail that can't be removed must not fail the delete.
export async function deleteThumbnail(thumbsDir: string, pathId: string): Promise<void> {
    await fs.promises.rm(thumbnailPath(thumbsDir, pathId), { force: true }).catch(() => {});
}

export async function getThumbnail(thumbsDir: string, pathId: string): Promise<BunFile | null> {
    const file = Bun.file(thumbnailPath(thumbsDir, pathId));
    return (await file.exists()) ? file : null;
}

function thumbnailFileName(pathId: string): string {
    return `${pathId}.webp`;
}

function thumbnailPath(thumbsDir: string, pathId: string): string {
    return path.join(thumbsDir, thumbnailFileName(pathId));
}
