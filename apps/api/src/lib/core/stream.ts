// The one loop that reads a stream chunk by chunk, such as a request body or a storage read, and the event
// loop turn it gives every 2 MiB, so a large local file never holds the API while it is read. A storage
// read runs it with an idle deadline; a request body or a local file runs it without one. Other long
// loops, such as a backup's walk over a drive, take the same turn between steps.

import { ApiError, payloadTooLarge, storageUnavailable } from './errors';

const YIELD_EVERY_BYTES = 2 * 1024 * 1024;

// Answers the total, and a 413 past maxBytes. With idleMs it is a storage read: silence for idleMs, an aborted
// signal or a failed read cancels it and answers 503.
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
    let unyielded = 0;
    try {
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
            if (size > maxBytes) throw payloadTooLarge();
            onChunk(value);
            unyielded += value.byteLength;
            if (unyielded >= YIELD_EVERY_BYTES) {
                unyielded = 0;
                await eventLoopTurn();
            }
        }
    } catch (error) {
        reader.cancel().catch(() => {});
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
    }
}

export function eventLoopTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}
