import { ApiError, payloadTooLarge, storageUnavailable } from './errors';

const YIELD_EVERY_BYTES = 2 * 1024 * 1024;

// The empty second immediate keeps the loop awake: inside `expect().rejects`, which waits on its promise
// synchronously, Bun otherwise sleeps until the next timer before it runs what the first one resolved.
export function eventLoopTurn(): Promise<void> {
    return new Promise((resolve) =>
        setImmediate(() => {
            resolve();
            setImmediate(() => {});
        }),
    );
}

// The one stream loop: pulls chunk by chunk and reports the total, past maxBytes a 413. With
// idleMs it is a storage read: silence for idleMs, an aborted signal or a failed read cancels it and answers 503.
export async function consumeStream(
    stream: ReadableStream<Uint8Array>,
    onChunk: (chunk: Uint8Array) => void,
    opts: { idleMs?: number; maxBytes?: number; signal?: AbortSignal; yields?: boolean } = {},
): Promise<number> {
    const { idleMs, maxBytes = Number.POSITIVE_INFINITY, signal, yields = false } = opts;
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
        // Opt-in: a warm local read never leaves the microtasks, which is all that keeps an unlocked reader whole.
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
            if (yields && unyielded >= YIELD_EVERY_BYTES) {
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
