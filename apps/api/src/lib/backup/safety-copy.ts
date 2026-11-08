// Lists, measures and deletes the safety copies that restores leave beside a home. A home whose files live in an
// S3 bucket has its objects deleted with the copy, so the delete asks the mount settings in the folder where they
// are. An admin lists the copies in the backup pane and decides. Deleting the owner, such as a user or a team,
// removes them too, and this file says which bucket objects that home and its copies name.

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { MountConfig } from '@workspace/lib/types';
import type { BackupSafetyCopy } from '@workspace/lib/types/backup';
import { PATHS } from '../config/paths';
import { ApiError } from '../core';
import { createMountConfig, createMountStorage } from '../mount/helpers';
import type { StorageBackend } from '../storage';
import { readHomeMounts } from './enumerate-homes';
import { resolveHomeDir } from './home-dir';
import { parseSafetyCopyName } from './paths';

// The walk stops here so a huge home does not stall the list, and the size is then reported as a floor (`truncated`).
const MAX_WALKED_FILES = 50_000;

// Deleting an owner's objects: how many DELETEs one bucket gets at once, and how many refusals in a row give it up.
const OBJECT_DELETES_IN_FLIGHT = 8;
const MAX_REFUSED_DELETES_IN_A_ROW = 10;

type FolderSize = { bytes: number; truncated: boolean };

// A safety copy never changes after its restore, so it is measured once per process.
// The list refetches on every job start and end.
const measuredBytes = new Map<string, FolderSize>();

// The folders a restore left beside this home, as the admin pane lists them: with their size and the delete.
export async function listSafetyCopies(ownerId: string): Promise<BackupSafetyCopy[]> {
    const homeDir = await resolveHomeDir(ownerId);
    const copies: BackupSafetyCopy[] = [];
    for (const folder of homeFolders(homeDir)) {
        const name = path.basename(folder);
        const parsed = parseSafetyCopyName(name);
        if (!parsed) continue;
        const { bytes, truncated } = await measureSafetyCopy(folder);
        copies.push({ name, kind: parsed.kind, createdAt: parsed.at, bytes, truncated });
    }
    return copies.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// Every route that names a safety copy resolves it here first. The name has to parse as one AND
// name this owner's home folder; both hold before any path is built, let alone removed or renamed.
export async function resolveSafetyCopy(
    ownerId: string,
    name: string,
): Promise<{ folder: string; homeDir: string; kind: BackupSafetyCopy['kind'] }> {
    const homeDir = await resolveHomeDir(ownerId);
    const parsed = parseSafetyCopyName(name);
    if (!parsed || parsed.homeName !== path.basename(homeDir)) {
        throw new ApiError(400, 'Not a safety copy of this home');
    }
    return { folder: path.join(path.dirname(homeDir), name), homeDir, kind: parsed.kind };
}

export async function deleteSafetyCopy(folder: string, homeDir: string): Promise<void> {
    await deleteRemoteObjects(folder, homeDir);
    await fsp.rm(folder, { recursive: true, force: true });
    forgetSafetyCopySize(folder);
}

// Every object an owner's home and safety copies name on an s3 mount, by bucket, read before the folders go
// since they are the only record of whose objects these are. All of them go: no other home names these keys.
export type BucketObjects = { storage: StorageBackend; keys: Set<string> };

export function collectHomeObjects(homeDir: string): { folders: string[]; buckets: BucketObjects[] } {
    const folders = homeFolders(homeDir).filter((folder) => fs.existsSync(folder));
    const buckets = new Map<string, BucketObjects>();
    for (const folder of folders) {
        for (const { id, mountDir, metadataPath, config } of remoteMountsOf(folder)) {
            let keys: Set<string>;
            try {
                keys = storageKeysIn(metadataPath);
            } catch (error) {
                console.warn(
                    `[backup] ${path.basename(folder)}: mount ${id} does not read, leaving its objects:`,
                    error,
                );
                continue;
            }
            const destination = JSON.stringify(config.s3Config);
            let bucket = buckets.get(destination);
            if (!bucket) {
                bucket = { storage: createMountStorage(config, mountDir), keys: new Set() };
                buckets.set(destination, bucket);
            }
            for (const key of keys) bucket.keys.add(key);
        }
    }
    return { folders, buckets: [...buckets.values()] };
}

// A failed DELETE is kept and the rest go on, since nothing retries them.
// A bucket that refuses a run of them is down or revoked, so its remaining keys count as failed.
export async function deleteBucketObjects(buckets: BucketObjects[]): Promise<string[]> {
    const failed: string[] = [];
    for (const { storage, keys } of buckets) {
        const pending = [...keys];
        let refusedInARow = 0;
        for (let start = 0; start < pending.length; start += OBJECT_DELETES_IN_FLIGHT) {
            const chunk = pending.slice(start, start + OBJECT_DELETES_IN_FLIGHT);
            const results = await Promise.all(chunk.map((key) => storage.delete(key)));
            for (const [i, deleted] of results.entries()) {
                refusedInARow = deleted ? 0 : refusedInARow + 1;
                if (!deleted) failed.push(chunk[i]);
            }
            if (refusedInARow >= MAX_REFUSED_DELETES_IN_A_ROW) {
                failed.push(...pending.slice(start + chunk.length));
                break;
            }
        }
    }
    return failed;
}

// A later copy can land on the same name (stamps are per second) and would list the old folder's size.
export function forgetSafetyCopySize(dir: string): void {
    measuredBytes.delete(dir);
}

async function measureFolder(dir: string): Promise<FolderSize> {
    let bytes = 0;
    let walked = 0;
    const stack = [dir];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
        for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
            if (walked++ >= MAX_WALKED_FILES) return { bytes, truncated: true };
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(abs);
            else if (entry.isFile()) bytes += (await fsp.stat(abs)).size;
        }
    }
    return { bytes, truncated: false };
}

async function measureSafetyCopy(dir: string): Promise<FolderSize> {
    const known = measuredBytes.get(dir);
    if (known) return known;
    const size = await measureFolder(dir);
    measuredBytes.set(dir, size);
    return size;
}

// Every folder that stands for a state of the home: the home itself and the safety copies beside it.
function homeFolders(homeDir: string): string[] {
    const parent = path.dirname(homeDir);
    const homeName = path.basename(homeDir);
    const folders = [homeDir];
    if (!fs.existsSync(parent)) return folders;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && parseSafetyCopyName(entry.name)?.homeName === homeName) {
            folders.push(path.join(parent, entry.name));
        }
    }
    return folders;
}

// Takes the objects only this copy points at; the live home's and other copies' stay.
// A delete that fails keeps the folder, the only record of which objects those are.
async function deleteRemoteObjects(folder: string, homeDir: string): Promise<void> {
    const remote = remoteMountsOf(folder);
    if (remote.length === 0) return;
    if (!fs.existsSync(homeDir)) {
        console.warn(`[backup] ${path.basename(folder)}: no live home to compare against, leaving its objects alone`);
        return;
    }
    // Two copies can name the same object (a restore only rekeys the rows it carries), so an object one of
    // them still points at is not garbage, whatever the folder being deleted says.
    const referencing = homeFolders(homeDir).filter((dir) => dir !== folder);
    for (const { id, mountDir, metadataPath, config } of remote) {
        // Nothing to hold the copy's keys against: the mount is gone from the live home, and an
        // object it may still hold is not this delete's to judge.
        if (!fs.existsSync(path.join(homeDir, PATHS.DRIVE.ROOT, id, PATHS.DRIVE.METADATA_DB))) continue;
        const referenced = new Set<string>();
        for (const dir of referencing) {
            const referencingDb = path.join(dir, PATHS.DRIVE.ROOT, id, PATHS.DRIVE.METADATA_DB);
            if (fs.existsSync(referencingDb)) {
                for (const key of storageKeysIn(referencingDb)) referenced.add(key);
            }
        }

        const storage = createMountStorage(config, mountDir);
        for (const key of storageKeysIn(metadataPath)) {
            if (referenced.has(key)) continue;
            // A missing key answers true (a failed restore's keys were staged, never uploaded); false is
            // an outage, a 403, a rotated key, and the copy stays anyway, so the rest can wait.
            if (!(await storage.delete(key))) {
                throw new ApiError(503, 'An object could not be deleted; the safety copy was kept');
            }
        }
    }
}

type RemoteMount = { id: string; mountDir: string; metadataPath: string; config: MountConfig };

// The s3 mounts of one home folder that have a metadata.db to name their keys, each with the config its
// objects are under.
function remoteMountsOf(folder: string): RemoteMount[] {
    const mounts = readHomeMounts(folder);
    if (!mounts) {
        console.warn(`[backup] ${path.basename(folder)}: ${PATHS.SETTINGS} is unreadable, leaving its objects alone`);
        return [];
    }
    const remote: RemoteMount[] = [];
    for (const [id, settings] of Object.entries(mounts)) {
        if (settings.storageType !== 's3') continue;
        const mountDir = path.join(folder, PATHS.DRIVE.ROOT, id);
        const metadataPath = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
        if (!fs.existsSync(metadataPath)) continue;
        // A mount with no S3 config of its own keeps its objects in the server's default bucket. On a bucket two
        // servers share, only its versioning can undo a delete.
        const config = createMountConfig(id, settings);
        if (!config.s3Config) {
            console.warn(`[backup] ${path.basename(folder)}: mount ${id} has no S3 config, leaving its objects`);
            continue;
        }
        remote.push({ id, mountDir, metadataPath, config });
    }
    return remote;
}

// Read-write on purpose: a WAL database whose owner is not holding it open has no -shm, and a read-only open fails.
function storageKeysIn(metadataPath: string): Set<string> {
    const db = new Database(metadataPath, { readwrite: true, create: false });
    try {
        const keys = new Set<string>();
        const rows = db.query<{ file: string }, []>("SELECT file FROM paths WHERE type = 'file'");
        for (const row of rows.iterate()) keys.add(row.file);
        return keys;
    } finally {
        db.close();
    }
}
