import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError, storageUnavailable } from '../core/errors';
import { consumeStream, eventLoopTurn } from '../core/stream';
import type { StorageFile } from './types';

// Eigen's own bound on an S3 metadata call and on a storage read that stops delivering bytes: Bun's
// S3Client gives up only after about 360 s of silence. A setter so tests can shrink it.
export const STORAGE_TIMEOUT_MS = 30_000;
let storageTimeoutMs = STORAGE_TIMEOUT_MS;

export function setStorageTimeoutMs(ms: number): void {
    storageTimeoutMs = ms;
}

// Node puts the errno on the Error as `code`; a thrown value that is not one has none.
export function errnoOf(error: unknown): string | null {
    return error instanceof Error && 'code' in error ? String(error.code) : null;
}

// A storage call wraps the backend's error in an ApiError, whose cause carries the code.
export function causeCode(error: unknown): string | null {
    return errnoOf(error instanceof ApiError ? error.cause : error);
}

// Only a GET body's code tells a gone key from a gone bucket or a refused one: S3Error carries no status.
export function isMissingObjectCause(error: unknown): error is ApiError {
    if (!(error instanceof ApiError)) return false;
    const code = causeCode(error);
    return code === 'NoSuchKey' || code === 'ENOENT';
}

// A request Bun's S3Client cannot abort keeps running in the background; only the caller stops waiting, and the
// signal tells a retry to stop too.
export function withStorageDeadline<T>(request: (deadline: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        Promise.try(request, deadline.signal),
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                deadline.abort();
                reject(storageUnavailable());
            }, storageTimeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
}

// One wait before each retry, so a read gets one attempt more than there are waits. A setter so tests can shrink them.
export const RETRY_WAITS_MS: readonly number[] = [200, 800];
let retryWaitsMs = RETRY_WAITS_MS;

export function setRetryWaitsMs(waits: readonly number[]): void {
    retryWaitsMs = waits;
}

// Bun's S3Client reports a HEAD's 5xx and 403 alike as UnknownError, as a HEAD has no body: both are retried.
const TRANSIENT_S3_CODES = new Set([
    'SlowDown',
    'ServiceUnavailable',
    'InternalError',
    'RequestTimeout',
    'UnknownError',
    'ConnectionRefused',
    'ConnectionClosed',
]);

// Bun's S3Client never retries a read, and a provider shedding load (Hetzner's 503 SlowDown) answers the same
// request a second later. A wait stops at the signal, and the last failure is what the caller sees.
export async function retryStorageRead<T>(
    op: string,
    key: string,
    read: () => Promise<T>,
    { signal, canRetry }: { signal?: AbortSignal; canRetry?: () => boolean } = {},
): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await read();
        } catch (error) {
            const code = causeCode(error);
            const wait = retryWaitsMs[attempt - 1];
            if (
                code === null ||
                !TRANSIENT_S3_CODES.has(code) ||
                wait === undefined ||
                signal?.aborted ||
                canRetry?.() === false
            ) {
                throw error;
            }
            console.warn(`Storage ${op} of ${key} failed with ${code} on attempt ${attempt}, retrying`);
            await sleep(wait + Math.random() * (wait / 2), undefined, { signal }).catch(() => {
                throw error;
            });
        }
    }
}

// A metadata read: every attempt inside one storage deadline.
export function storageRead<T>(op: string, key: string, read: () => Promise<T>): Promise<T> {
    return withStorageDeadline((signal) => retryStorageRead(op, key, read, { signal }));
}

// consumeStream over a StorageFile, under the storage idle deadline. A GET that failed before its first byte is
// retried; one that stalled into the deadline is not, its 503 carrying no cause.
export function streamStorageFile(
    file: StorageFile,
    onChunk: (chunk: Uint8Array) => void,
    opts: { maxBytes?: number; signal?: AbortSignal; yields?: boolean } = {},
): Promise<number> {
    let started = false;
    const read = () =>
        consumeStream(
            file.stream(),
            (chunk) => {
                started = true;
                onChunk(chunk);
            },
            { ...opts, idleMs: storageTimeoutMs },
        );
    return retryStorageRead('read', file.name ?? '', read, { signal: opts.signal, canRetry: () => !started });
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
    opts: { signal?: AbortSignal; yields?: boolean } = {},
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
                : await streamStorageFile(data, onChunk, opts);
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
    await eventLoopTurn();
    const hasher = new Bun.CryptoHasher('sha256');
    const size = await consumeStream(Bun.file(filePath).stream(), (chunk) => hasher.update(chunk), { yields: true });
    return { size, hash: hasher.digest('hex') };
}
