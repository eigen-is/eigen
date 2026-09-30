import * as path from 'node:path';
import { isS3ConfigValid, type S3Config } from '@workspace/lib/types/mount';
import type { S3CheckResult, ServerSettings } from '@workspace/lib/types/settings';
import { parseServerArchiveName } from '@workspace/lib/validation';
import { getS3Config, getServerSettings } from '../config/server-settings';
import { ApiError } from '../core';
import { checkS3Connection, S3Storage, s3Endpoint } from '../storage/s3-storage';
import { listHomeMounts } from './enumerate-homes';
import { pruneServerArchives } from './retention';

// S3 takes at most 10,000 parts, and Bun's smallest is 5 MiB, which would cap an archive at 50 GB.
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;

type BackupUpload = ServerSettings['backups']['upload'];

// One bucket whatever the prefix or the scheme: two prefixes in it share its keys and its fate (D13).
function bucketOf(config: S3Config): string | null {
    const host = URL.parse(s3Endpoint(config))?.host;
    return host ? `${host.toLowerCase()}/${config.bucket}` : null;
}

// The buckets Eigen keeps files in: the default mount's, and every home's s3 mounts, safety copies included.
function dataBuckets(): Set<string> {
    const saved = getS3Config();
    const mounts = listHomeMounts().flatMap(({ mounts }) => mounts.flatMap(({ s3Config }) => s3Config ?? []));
    return new Set([...(saved ? [saved] : []), ...mounts].flatMap((config) => bucketOf(config) ?? []));
}

// On the owner's Test, on every save that turns uploads on, and before every upload: a mount may have
// been added since the destination was saved. The bucket check comes first, so nothing is written to a data bucket.
export async function checkBackupDestination(config: S3Config): Promise<S3CheckResult> {
    if (!isS3ConfigValid(config)) return { ok: false, message: 'Fill in the endpoint, the bucket and both keys' };
    const bucket = bucketOf(config);
    if (!bucket) return { ok: false, message: 'The endpoint is not a web address' };
    if (dataBuckets().has(bucket)) {
        return {
            ok: false,
            message:
                'This bucket holds Eigen data. Backups need a bucket of their own, so one lost bucket or key cannot take both.',
        };
    }
    return checkS3Connection(config, { refusePublic: true });
}

// A destination as the owner sends it, over the saved one. A field left out keeps its saved value, and so
// does a blank secret, which is how the settings reach an admin. A secret goes with its key id, so a new
// key id needs its own.
export function withSavedSecret(s3: Partial<S3Config>): S3Config {
    const saved = getServerSettings().backups.upload.s3;
    const next = { ...saved, ...s3 };
    if (s3.secretAccessKey) return next;
    if (next.accessKeyId !== saved.accessKeyId) {
        throw new ApiError(400, 'Enter the secret key that goes with this access key');
    }
    return { ...next, secretAccessKey: saved.secretAccessKey };
}

// The upload settings a save would store, checked when they are on. `changed` says the destination is new,
// which the owner must hear about once.
export async function resolveBackupUpload(update: {
    enabled?: boolean;
    s3?: Partial<S3Config>;
    keep?: number;
}): Promise<{ upload: BackupUpload; changed: boolean }> {
    const saved = getServerSettings().backups.upload;
    const upload = { ...saved, ...update, s3: update.s3 ? withSavedSecret(update.s3) : saved.s3 };
    if (upload.enabled) {
        const check = await checkBackupDestination(upload.s3);
        if (!check.ok) throw new ApiError(400, `The backup bucket was refused: ${check.message}`);
    }
    return { upload, changed: isS3ConfigValid(upload.s3) && !Bun.deepEquals(upload.s3, saved.s3) };
}

export function backupKey(destination: S3Config, name: string): string {
    return new S3Storage(destination).getKey(name);
}

// The bytes that leave the box. Encryption, when it comes, is a transform of this stream.
function sealArchive(archivePath: string): ReadableStream<Uint8Array> {
    return Bun.file(archivePath).stream();
}

// Only scheduled archives, and only by name. Only a good archive is uploaded, a manual one is the owner's,
// a pre-update one never left its box, and a key the grammar does not read is not an archive.
async function pruneRemoteArchives(bucket: S3Storage, keep: number): Promise<void> {
    const scheduled = (await bucket.list()).filter((name) => parseServerArchiveName(name)?.reason === 'scheduled');
    for (const name of pruneServerArchives(
        scheduled.map((name) => ({ name, good: true })),
        keep,
    )) {
        await bucket.delete(name);
    }
}

// Streams a finished archive to the bucket under its own name, checks the bucket holds all of it, then
// prunes the bucket. Bun aborts the multipart upload when a part or the stream fails, and pruning never
// runs after a failure. Resolves to the object's key.
export async function uploadServerArchive(archivePath: string, destination: S3Config, keep: number): Promise<string> {
    const check = await checkBackupDestination(destination);
    if (!check.ok) throw new Error(`The backup bucket was refused: ${check.message}`);
    const name = path.basename(archivePath);
    const bytes = Bun.file(archivePath).size;
    const bucket = new S3Storage(destination);
    await bucket.read(name).write(new Response(sealArchive(archivePath)), {
        partSize: Math.max(MIN_PART_BYTES, Math.ceil(bytes / MAX_PARTS)),
    });
    const stored = await bucket.size(name);
    if (stored !== bytes) {
        await bucket.delete(name);
        throw new Error(`The bucket holds ${stored ?? 'no'} bytes of ${name}, not ${bytes}`);
    }
    // Pruning that fails must not turn an upload that worked into one that did not.
    await pruneRemoteArchives(bucket, keep).catch(console.error);
    return bucket.getKey(name);
}
