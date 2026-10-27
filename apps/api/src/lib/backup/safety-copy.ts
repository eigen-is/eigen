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
import { flatStorageKey } from './archive-layout';
import { readHomeMounts } from './enumerate-homes';
import { resolveHomeDir } from './home-dir';
import { parseSafetyCopyName, resolveMountDir } from './paths';

// The folders a restore leaves beside a home, and what deleting one means when the home's bytes are
// in a bucket rather than in the folder. An admin lists these in the pane and decides; only deleting
// their user takes them otherwise.

// A safety copy holds a whole home; its size is a line in a list, not an accounting figure, so the
// walk stops here and the number becomes a floor rather than taking a minute on a huge home. The
// floor is reported as one (`truncated`), because "52.79 MB" for a 284 MB copy is a lie the admin
// would act on.
const MAX_WALKED_FILES = 50_000;

// Deleting an owner's objects: how many DELETEs one bucket gets at once, and how many refusals in a row give it up.
const OBJECT_DELETES_IN_FLIGHT = 8;
const MAX_REFUSED_DELETES_IN_A_ROW = 10;

type FolderSize = { bytes: number; truncated: boolean };

// A safety copy never changes after the restore that made it, so it is measured once per process.
// The artifact list is refetched on every job poke — up to twice a second while a job runs — and
// walking a whole home on each of those would stall the event loop for every user on the server.
const measuredBytes = new Map<string, FolderSize>();

export async function measureFolder(dir: string, maxFiles = MAX_WALKED_FILES): Promise<FolderSize> {
    let bytes = 0;
    let walked = 0;
    const stack = [dir];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
        for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
            if (walked++ >= maxFiles) return { bytes, truncated: true };
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

// Every way a safety copy stops being at that path: deleted, or renamed back over the home by a
// restore of it. A later copy can land on the same name (one stamp per second), and it would then
// list the size of the folder that used to be there.
export function forgetSafetyCopySize(dir: string): void {
    measuredBytes.delete(dir);
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

// The storage keys one mount's metadata.db points at, on a flat-key backend. Read-write on purpose:
// a WAL database whose owner is not holding it open has no -shm beside it, and a read-only open of
// one fails outright — which is exactly the shape of a home folder moved aside.
function storageKeysIn(metadataPath: string): Set<string> {
    const db = new Database(metadataPath, { readwrite: true, create: false });
    try {
        const keys = new Set<string>();
        const rows = db.query<{ id: string; file: string }, []>("SELECT id, file FROM paths WHERE type = 'file'");
        for (const row of rows.iterate()) keys.add(flatStorageKey(row));
        return keys;
    } finally {
        db.close();
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
        // settings.json of a safety copy came from an archive, so its keys are untrusted: a mount id that
        // resolves outside this folder would have this reading — and deleting the objects of — another home.
        const mountDir = resolveMountDir(folder, id);
        if (!mountDir) continue;
        const metadataPath = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
        if (!fs.existsSync(metadataPath)) continue;
        // A mount with no S3 config of its own keeps its objects in the server's default bucket; a bucket two
        // servers share has only its versioning to undo a delete (BACKUP.md).
        const config = createMountConfig(id, settings);
        if (!config.s3Config) {
            console.warn(`[backup] ${path.basename(folder)}: mount ${id} has no S3 config, leaving its objects`);
            continue;
        }
        remote.push({ id, mountDir, metadataPath, config });
    }
    return remote;
}

// A remote mount keeps its bytes in a bucket, not in the home folder, so removing a safety copy has
// to take the objects only that copy points at with it. Anything the live home or another copy still
// names is left alone. A delete that does not land keeps the whole folder: it is the only record of
// which objects those bytes belong to, and losing it would orphan a home's worth of them in silence.
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
        const liveMountDir = resolveMountDir(homeDir, id);
        if (!liveMountDir || !fs.existsSync(path.join(liveMountDir, PATHS.DRIVE.METADATA_DB))) continue;
        const referenced = new Set<string>();
        for (const dir of referencing) {
            const referencingMount = resolveMountDir(dir, id);
            const referencingDb = referencingMount && path.join(referencingMount, PATHS.DRIVE.METADATA_DB);
            if (referencingDb && fs.existsSync(referencingDb)) {
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

export async function deleteSafetyCopy(folder: string, homeDir: string): Promise<void> {
    await deleteRemoteObjects(folder, homeDir);
    await fsp.rm(folder, { recursive: true, force: true });
    forgetSafetyCopySize(folder);
}

// What deleting an owner leaves in buckets: every object its home and safety copies name on an s3 mount. Read
// before the folders go, since they are the only record of whose objects these are. All of them go: no other
// home names these keys (a copy writes new objects, a restore rekeys, a team's mount is its own).
export function collectHomeObjects(homeDir: string): {
    folders: string[];
    objectCount: number;
    deleteObjects: () => Promise<string[]>;
} {
    const folders = homeFolders(homeDir).filter((folder) => fs.existsSync(folder));
    const buckets = new Map<string, { storage: StorageBackend; keys: Set<string> }>();
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
            const bucket = buckets.get(destination) ?? {
                storage: createMountStorage(config, mountDir),
                keys: new Set(),
            };
            buckets.set(destination, bucket);
            for (const key of keys) bucket.keys.add(key);
        }
    }
    // A failed DELETE is kept and the rest go on, since nothing retries them; a bucket that refuses a run of
    // them is down or revoked, and its remaining keys count as failed rather than waiting out a timeout each.
    const deleteObjects = async (): Promise<string[]> => {
        const failed: string[] = [];
        for (const { storage, keys } of buckets.values()) {
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
    };
    let objectCount = 0;
    for (const { keys } of buckets.values()) objectCount += keys.size;
    return { folders, objectCount, deleteObjects };
}
