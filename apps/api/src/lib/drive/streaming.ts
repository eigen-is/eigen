import { randomUUID } from 'node:crypto';
import type { CryptoHasher, FileSink } from 'bun';
import { ApiError } from '../core';
import type { Mount } from '../mount';
import { MaxFileSizeExceededError, parseMultipartRequest } from '../multipart';
import { getStorageTimeoutMs, type StorageFile } from '../storage';

export type StreamResult = {
    tempId: string;
    hash: string;
    size: number;
    mimeType: string;
    fileName: string;
};

type InFlightFile = {
    tempId: string;
    writer: FileSink;
    hasher: CryptoHasher;
    fileName: string;
    mimeType: string;
};

export async function streamFilesToTemp(
    mount: Mount,
    request: Request,
    maxSizePerFile: number,
): Promise<StreamResult[]> {
    const results: StreamResult[] = [];
    let current: InFlightFile | null = null;

    try {
        for await (const event of parseMultipartRequest(request, { maxFileSize: maxSizePerFile })) {
            if (event.type === 'part') {
                if (!event.filename) continue; // non-file field: chunks fall through unconsumed
                const tempId = randomUUID();
                current = {
                    tempId,
                    writer: Bun.file(mount.getTempPath(tempId)).writer({ highWaterMark: 256 * 1024 }),
                    hasher: new Bun.CryptoHasher('sha256'),
                    fileName: event.filename,
                    mimeType: event.mediaType || 'application/octet-stream',
                };
            } else if (event.type === 'chunk') {
                if (current) {
                    current.hasher.update(event.data);
                    current.writer.write(event.data);
                }
            } else if (event.type === 'end' && current) {
                await current.writer.end();
                results.push({
                    tempId: current.tempId,
                    hash: current.hasher.digest('hex'),
                    size: event.size,
                    mimeType: current.mimeType,
                    fileName: current.fileName,
                });
                current = null;
            }
        }
    } catch (e) {
        // Clean up the in-flight file and any temp files from already-parsed parts
        if (current) {
            try {
                await current.writer.end();
            } catch {}
            await mount.cleanupTemp(current.tempId);
        }
        await Promise.all(results.map((r) => mount.cleanupTemp(r.tempId)));
        if (e instanceof MaxFileSizeExceededError) {
            throw new ApiError(413, 'File exceeds maximum upload size');
        }
        throw e;
    }

    if (results.length === 0) {
        throw new ApiError(400, 'No file found in request');
    }

    return results;
}

// The one streaming loop behind writeTempWithHash and hashFile: pulls the stream chunk by chunk
// and reports the total, so neither of them holds the payload in memory. With a bound, a stream that
// stays silent for idleMs, or whose signal aborts, is cancelled and answers 503.
async function consumeStream(
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: Uint8Array) => void,
    bound?: { idleMs: number; signal?: AbortSignal },
): Promise<number> {
    const reader = stream.getReader();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
        stopped = true;
        reader.cancel().catch(() => {});
    };
    bound?.signal?.addEventListener('abort', stop);
    if (bound?.signal?.aborted) stop();
    try {
        let size = 0;
        while (true) {
            if (bound) {
                clearTimeout(timer);
                timer = setTimeout(stop, bound.idleMs);
            }
            // A read pending when cancel() runs resolves done rather than throwing, hence the flag.
            const { done, value } = await reader.read();
            if (stopped) throw new ApiError(503, 'Storage unavailable');
            if (done) break;
            onChunk(value);
            size += value.byteLength;
        }
        return size;
    } finally {
        clearTimeout(timer);
        bound?.signal?.removeEventListener('abort', stop);
    }
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
            isBody ? undefined : { idleMs: getStorageTimeoutMs(), signal },
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
