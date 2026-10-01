import { ApiError } from '../core/errors';
import type { StorageFile } from './types';

// Eigen's own bound on an S3 metadata call and on a storage read that stops delivering bytes: Bun's
// S3Client gives up only after about 360 s of silence. A setter so tests can shrink it.
export const STORAGE_TIMEOUT_MS = 30_000;
let storageTimeoutMs = STORAGE_TIMEOUT_MS;

export function setStorageTimeoutMs(ms: number): void {
    storageTimeoutMs = ms;
}

// The one 503 a storage outage answers; an ApiError already on its way out passes through.
export function storageUnavailable(cause?: unknown): ApiError {
    if (cause instanceof ApiError) return cause;
    return new ApiError(503, 'Storage unavailable', cause === undefined ? undefined : { cause });
}

// A stored object that is gone for good, after the temp and the staged copy were checked: 410, as the row
// still resolves.
export function storageGone(cause?: unknown): ApiError {
    return new ApiError(410, 'Stored data not found', cause === undefined ? undefined : { cause });
}

// Node puts the errno on the Error as `code`; a thrown value that is not one has none.
export function errnoOf(error: unknown): string | null {
    return error instanceof Error && 'code' in error ? String(error.code) : null;
}

// Only a GET body's code tells a gone key from a gone bucket or a refused one: S3Error carries no status.
export function isMissingObjectCause(error: unknown): error is ApiError {
    const code = error instanceof ApiError ? errnoOf(error.cause) : null;
    return code === 'NoSuchKey' || code === 'ENOENT';
}

// A request Bun's S3Client cannot abort keeps running in the background; only the caller stops waiting.
export function withStorageDeadline<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        request,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(storageUnavailable()), storageTimeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
}

// The one storage stream loop: pulls chunk by chunk and reports the total, past maxBytes a 413. With
// idleMs it is a storage read: silence for idleMs, an aborted signal or a failed read cancels it and answers 503.
export async function consumeStream(
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: Uint8Array) => void,
    opts: { idleMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<number> {
    const { idleMs, maxBytes = Number.POSITIVE_INFINITY, signal } = opts;
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
        reader = stream.getReader();
    } catch (error) {
        // Bun opens a local file here, so a missing one throws its ENOENT before the first read.
        if (idleMs === undefined) throw error;
        throw storageUnavailable(error);
    }
    let stopped = false;
    const stop = () => {
        stopped = true;
        reader.cancel().catch(() => {});
    };
    const timer = idleMs === undefined ? undefined : setTimeout(stop, idleMs);
    signal?.addEventListener('abort', stop);
    if (signal?.aborted) stop();
    let size = 0;
    try {
        // Never yields to the event loop: readers and in-place writers of a local file rely on a copy not interleaving.
        while (true) {
            timer?.refresh();
            // A read pending when cancel() runs resolves done rather than throwing, hence the flag.
            const { done, value } = await reader.read().catch((error: unknown) => {
                if (idleMs === undefined || error instanceof ApiError) throw error;
                console.error('Storage read failed:', error);
                throw storageUnavailable(error);
            });
            if (stopped) throw storageUnavailable();
            if (done) return size;
            size += value.byteLength;
            if (size > maxBytes) throw new ApiError(413, 'Upload too large');
            onChunk(value);
        }
    } catch (error) {
        reader.cancel().catch(() => {});
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
    }
}

// consumeStream over a StorageFile, under the storage idle deadline.
export function streamStorageFile(
    file: StorageFile,
    onChunk: (chunk: Uint8Array) => void,
    opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<number> {
    return consumeStream(file.stream(), onChunk, { ...opts, idleMs: storageTimeoutMs });
}

// file.arrayBuffer() as a storage read, for a body held whole in memory.
export async function readStorageFile(
    file: StorageFile,
    opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    await streamStorageFile(file, (chunk) => chunks.push(chunk), opts);
    return Bun.concatArrayBuffers(chunks);
}

// Stream a buffer, StorageFile (BunFile/S3File), or ReadableStream into a temp path while
// computing the sha256 hash in a single pass. Avoids holding the full payload in memory twice.
// A StorageFile read carries the storage idle deadline; a request body is the client's to pace.
export async function writeTempWithHash(
    tempPath: string,
    data: Buffer | Uint8Array | StorageFile | ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): Promise<{ size: number; hash: string }> {
    const hasher = new Bun.CryptoHasher('sha256');

    if (data instanceof Uint8Array) {
        await Bun.write(tempPath, data);
        hasher.update(data);
        return { size: data.byteLength, hash: hasher.digest('hex') };
    }

    const writer = Bun.file(tempPath).writer({ highWaterMark: 256 * 1024 });
    const onChunk = (chunk: Uint8Array) => {
        hasher.update(chunk);
        writer.write(chunk);
    };
    let size: number;
    try {
        size =
            data instanceof ReadableStream
                ? await consumeStream(data, onChunk)
                : await streamStorageFile(data, onChunk, { signal });
    } catch (error) {
        try {
            await writer.end();
        } catch {}
        throw error;
    }
    await writer.end();
    return { size, hash: hasher.digest('hex') };
}

// Read-only twin of writeTempWithHash, for bytes something else produced (a VACUUM INTO copy).
export async function hashFile(filePath: string): Promise<{ size: number; hash: string }> {
    const hasher = new Bun.CryptoHasher('sha256');
    const size = await consumeStream(Bun.file(filePath).stream(), (chunk) => hasher.update(chunk));
    return { size, hash: hasher.digest('hex') };
}
