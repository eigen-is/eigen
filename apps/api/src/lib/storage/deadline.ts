import { ApiError } from '../core';
import type { StorageFile } from './types';

// Eigen's own bound on an S3 metadata call and on a storage read that stops delivering bytes: Bun's
// S3Client gives up only after about 360 s of silence. A setter so tests can shrink it.
export const STORAGE_TIMEOUT_MS = 30_000;
let storageTimeoutMs = STORAGE_TIMEOUT_MS;

export function setStorageTimeoutMs(ms: number): void {
    storageTimeoutMs = ms;
}

export function getStorageTimeoutMs(): number {
    return storageTimeoutMs;
}

// A request Bun's S3Client cannot abort keeps running in the background; only the caller stops waiting.
export function withStorageDeadline<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        request,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ApiError(503, 'Storage unavailable')), storageTimeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
}

// The one stream loop: pulls chunk by chunk and reports the total, past maxBytes a 413. With idleMs it is
// a storage read: silence for idleMs, an aborted signal or a failed read cancels it and answers 503.
export async function consumeStream(
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: Uint8Array) => void,
    opts: { idleMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<number> {
    const { idleMs, maxBytes = Number.POSITIVE_INFINITY, signal } = opts;
    const reader = stream.getReader();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
        stopped = true;
        reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', stop);
    if (signal?.aborted) stop();
    let size = 0;
    try {
        while (true) {
            if (idleMs !== undefined) {
                clearTimeout(timer);
                timer = setTimeout(stop, idleMs);
            }
            // A read pending when cancel() runs resolves done rather than throwing, hence the flag.
            const { done, value } = await reader.read().catch((error: unknown) => {
                if (idleMs === undefined || error instanceof ApiError) throw error;
                console.error('Storage read failed:', error);
                throw new ApiError(503, 'Storage unavailable', { cause: error });
            });
            if (stopped) throw new ApiError(503, 'Storage unavailable');
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

// file.arrayBuffer() as a storage read, for a body held whole in memory.
export async function readStorageFile(
    file: StorageFile,
    opts: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<ArrayBuffer> {
    const chunks: Uint8Array[] = [];
    await consumeStream(file.stream(), (chunk) => chunks.push(chunk), { ...opts, idleMs: storageTimeoutMs });
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

    const isBody = data instanceof ReadableStream;
    const stream = isBody ? data : data.stream();
    const writer = Bun.file(tempPath).writer({ highWaterMark: 256 * 1024 });
    let failed = false;
    try {
        const size = await consumeStream(
            stream,
            (chunk) => {
                hasher.update(chunk);
                writer.write(chunk);
            },
            isBody ? {} : { idleMs: storageTimeoutMs, signal },
        );
        return { size, hash: hasher.digest('hex') };
    } catch (error) {
        failed = true;
        throw error;
    } finally {
        // The handle closes either way. On the way out from a failure that close is best-effort — it
        // must not replace the error that brought us here — but on a clean finish the flush is part
        // of the answer, so its failure is the caller's. A half-written temp is the caller's to delete.
        if (!failed) await writer.end();
        else {
            try {
                await writer.end();
            } catch {}
        }
    }
}

// Read-only twin of writeTempWithHash, for bytes something else produced (a VACUUM INTO copy).
export async function hashFile(filePath: string): Promise<{ size: number; hash: string }> {
    const hasher = new Bun.CryptoHasher('sha256');
    const size = await consumeStream(Bun.file(filePath).stream(), (chunk) => hasher.update(chunk));
    return { size, hash: hasher.digest('hex') };
}
