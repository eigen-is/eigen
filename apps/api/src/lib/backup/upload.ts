import * as path from 'node:path';
import { isS3ConfigValid, keepsSavedSecret, type S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult, ServerSettings } from '@workspace/lib/types/settings';
import { getDomain } from '../config/server-config';
import { getS3Config, getServerSettings } from '../config/server-settings';
import { ApiError } from '../core';
import { abortsIncompleteUploads, checkS3Connection, S3Storage } from '../storage/s3-storage';
import { listHomeMounts } from './enumerate-homes';
import { BUCKET_PARTIAL_SUFFIX } from './paths';
import { pruneBucketArchives } from './retention';

// S3 and Bun take parts of 5 MiB to 5 GiB, at most 10,000 of them. Two in flight hold 10 MiB up to a 50 GB
// archive and 128 MiB at 640 GB; past that the part grows with the archive, as 10,000 parts must hold it all.
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 5120 * 1024 * 1024;
const MAX_PARTS = 10_000;
const PARTS_IN_FLIGHT = 2;
// S3's rule for a bucket name. The public-read probe puts it in a URL.
const BUCKET_NAME = /^[a-z0-9.-]{3,63}$/;
const BAD_BUCKET_NAME = 'A bucket name is 3 to 63 lowercase letters, digits, dots and dashes';
const DATA_BUCKET =
    'A bucket of this name holds Eigen data. Backups need a bucket of their own, so one lost bucket or key cannot take both.';
const DATA_KEY =
    'This access key also opens a bucket that holds Eigen data. Backups need a key of their own, so one leaked key cannot reach both.';
const NO_ABORT_RULE =
    "No lifecycle rule on this bucket aborts an incomplete multipart upload. Add one with AbortIncompleteMultipartUpload after 1 day, so the parts of an upload cut off halfway don't stay and cost money.";

type BackupUpload = ServerSettings['backups']['upload'];

// The configs Eigen keeps files with: the default mount's, and every home's s3 mounts, safety copies included.
// A home whose settings do not read may name any bucket, so it refuses them all until it reads.
function dataOverlap(config: S3Config): string | null {
    const homes = listHomeMounts();
    const unread = homes.flatMap(({ folder, mounts }) => (mounts ? [] : [folder]));
    if (unread.length > 0) {
        return `The settings.json of ${unread.join(', ')} does not read, so any bucket may hold Eigen data. Fix it first.`;
    }
    const saved = getS3Config();
    const mounts = homes.flatMap(({ mounts }) => (mounts ?? []).flatMap(({ s3Config }) => s3Config ?? []));
    const configs = [...(saved ? [saved] : []), ...mounts];
    // By name alone: one provider answers to several hosts, and two prefixes in one bucket share its fate.
    const bucket = config.bucket.toLowerCase();
    if (configs.some((data) => data.bucket.toLowerCase() === bucket)) return DATA_BUCKET;
    if (configs.some((data) => data.accessKeyId === config.accessKeyId)) return DATA_KEY;
    return null;
}

// Two servers may share a bucket and a prefix: each keeps its archives, and prunes, in a folder named for its domain.
function serverPrefix(destination: S3Config): string {
    const folder = getDomain()
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, '-');
    return [destination.prefix, folder].filter(Boolean).join('/');
}

function serverBucket(destination: S3Config): S3Storage {
    return new S3Storage({ ...destination, prefix: serverPrefix(destination) });
}

// On the owner's Test, on every save that turns uploads on, and before every upload: a mount may have
// been added since the destination was saved. The bucket check comes first, so nothing is written to a data bucket.
export async function checkBackupDestination(config: S3Config): Promise<S3CheckResult> {
    if (!isS3ConfigValid(config)) return { ok: false, message: 'Fill in the endpoint, the bucket and both keys' };
    if (!BUCKET_NAME.test(config.bucket)) return { ok: false, message: BAD_BUCKET_NAME };
    const overlap = dataOverlap(config);
    if (overlap) return { ok: false, message: overlap };
    const result = await checkS3Connection(config, { refusePublic: true });
    if (!result.ok) return result;
    const aborts = await abortsIncompleteUploads(config, `${serverPrefix(config)}/`);
    return aborts ? result : { ...result, warning: NO_ABORT_RULE };
}

// A destination as the owner sends it, over the saved one. A field left out keeps its saved value, a blank secret
// the saved one where keepsSavedSecret allows it.
export function withSavedSecret(s3: Partial<S3Config>): S3Config {
    const saved = getServerSettings().backups.upload.s3;
    const next = { ...saved, ...s3 };
    if (s3.secretAccessKey) return next;
    if (!keepsSavedSecret(next, saved)) {
        throw new ApiError(400, 'Enter the secret key that goes with this bucket and access key');
    }
    return { ...next, secretAccessKey: saved.secretAccessKey };
}

// The upload settings a save would store, checked when they are on. `changed` says the destination is new,
// which the owner must hear about once; `warning` is what its check found lacking.
export async function resolveBackupUpload(update: {
    enabled?: boolean;
    s3?: Partial<S3Config>;
    keep?: number;
}): Promise<{ upload: BackupUpload; changed: boolean; warning?: string }> {
    const saved = getServerSettings().backups.upload;
    const upload = { ...saved, ...update, s3: update.s3 ? withSavedSecret(update.s3) : saved.s3 };
    if (upload.s3.bucket && !BUCKET_NAME.test(upload.s3.bucket)) throw new ApiError(400, BAD_BUCKET_NAME);
    let warning: string | undefined;
    if (upload.enabled) {
        const check = await checkBackupDestination(upload.s3);
        if (!check.ok) throw new ApiError(400, `The backup bucket was refused: ${check.message}`);
        warning = check.warning;
    }
    return { upload, changed: isS3ConfigValid(upload.s3) && !Bun.deepEquals(upload.s3, saved.s3), warning };
}

export function backupKey(destination: S3Config, name: string): string {
    return serverBucket(destination).getKey(name);
}

// The archive's bytes, failing once `signal` aborts, which makes Bun abort the multipart upload.
function abortableStream(archivePath: string, signal: AbortSignal): ReadableStream<Uint8Array> {
    const reader = Bun.file(archivePath).stream().getReader();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            const fail = () => {
                controller.error(signal.reason);
                reader.cancel(signal.reason).catch(() => {});
            };
            if (signal.aborted) fail();
            else signal.addEventListener('abort', fail, { once: true });
        },
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
        },
        cancel: (reason) => reader.cancel(reason),
    });
}

// Bun reads the stream's error only once the parts in flight settle, and a slow bucket may hold one past the
// shutdown budget: the upload stops waiting at the abort, and Bun aborts the multipart upload once they settle.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    const aborted = Promise.withResolvers<never>();
    const stop = () => aborted.reject(signal.reason);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    return Promise.race([work, aborted.promise]).finally(() => signal.removeEventListener('abort', stop));
}

// Only scheduled archives, and only by name: a manual one is the owner's, a pre-update one never left its box,
// and a key the grammar does not read is not an archive. An archive uploaded late may be one the keep would
// drop: it is not deleted as it lands, and this round deletes nothing.
async function pruneRemoteArchives(bucket: S3Storage, uploaded: string, keep: number): Promise<void> {
    const doomed = pruneBucketArchives(await bucket.list(), keep);
    if (doomed.includes(uploaded)) return;
    for (const name of doomed) await bucket.delete(name);
}

// Streams a finished archive to the bucket under its own name, checks the bucket holds all of it, then
// prunes the bucket to `keep` scheduled archives; `partial` says this one lacks a home. Bun aborts the
// multipart upload when a part or the stream fails, and pruning never runs after a failure.
export async function uploadServerArchive(
    archivePath: string,
    destination: S3Config,
    retention: { keep: number; partial?: boolean },
    signal: AbortSignal,
): Promise<void> {
    const check = await checkBackupDestination(destination);
    if (!check.ok) throw new Error(`The backup bucket was refused: ${check.message}`);
    const name = path.basename(archivePath);
    const bytes = Bun.file(archivePath).size;
    // Bun keeps a multipart upload within the part and queue sizes it is given.
    const partSize = Math.max(MIN_PART_BYTES, Math.ceil(bytes / MAX_PARTS));
    if (partSize > MAX_PART_BYTES) throw new Error(`The archive is too large for one S3 object: ${bytes} bytes`);
    const bucket = serverBucket(destination);
    // Before the archive, so the bucket never holds a partial one it would count as complete.
    if (retention.partial) await bucket.write(`${name}${BUCKET_PARTIAL_SUFFIX}`, new Uint8Array());
    const stream = new Response(abortableStream(archivePath, signal));
    await untilAborted(bucket.read(name).write(stream, { partSize, queueSize: PARTS_IN_FLIGHT }), signal);
    const stored = await bucket.size(name);
    if (stored === null) throw new Error(`The bucket did not say how many bytes of ${name} it holds`);
    if (stored !== bytes) {
        // Only a size the bucket stated says the object is short; a HEAD that failed says nothing of it.
        await bucket.delete(name);
        throw new Error(`The bucket holds ${stored} bytes of ${name}, not ${bytes}`);
    }
    // Pruning that fails must not turn an upload that worked into one that did not.
    await pruneRemoteArchives(bucket, name, retention.keep).catch(console.error);
}
