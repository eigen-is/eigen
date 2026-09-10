import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupSafetyCopy } from '@workspace/lib/types/backup';
import { parseHomeMountSettings } from '@workspace/lib/validation';
import { ApiError, PATHS } from '../core';
import { createMountStorage } from '../mount/helpers';
import { parseSafetyCopyName, resolveHomeDir, resolveMountDir } from './paths';
import { flatStorageKey } from './snapshot-mount';

// The folders a restore leaves beside a home, and what deleting one means when the home's bytes are
// in a bucket rather than in the folder. Nothing here ever runs automatically: an admin lists these
// in the pane and decides.

// A safety copy holds a whole home; its size is a line in a list, not an accounting figure, so the
// walk stops here and the number becomes a floor rather than taking a minute on a huge home. The
// floor is reported as one (`truncated`), because "52.79 MB" for a 284 MB copy is a lie the admin
// would act on.
const MAX_WALKED_FILES = 50_000;

type FolderSize = { bytes: number; truncated: boolean };

// A safety copy never changes after the restore that made it, so it is measured once per process.
// The artifact list is refetched on every job poke — up to twice a second while a job runs — and
// walking a whole home on each of those would stall the event loop for every user on the server.
const measuredBytes = new Map<string, FolderSize>();

export async function measureFolder(dir: string, maxFiles: number): Promise<FolderSize> {
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
    const size = await measureFolder(dir, MAX_WALKED_FILES);
    measuredBytes.set(dir, size);
    return size;
}

// Every way a safety copy stops being at that path: deleted, or renamed back over the home by a
// restore of it. A later copy can land on the same name (one stamp per second), and it would then
// list the size of the folder that used to be there.
export function forgetSafetyCopySize(dir: string): void {
    measuredBytes.delete(dir);
}

// The folders a restore left beside this home. Nothing deletes them automatically, so the admin
// pane lists them with their size and offers the delete.
export async function listSafetyCopies(ownerId: string): Promise<BackupSafetyCopy[]> {
    const homeDir = await resolveHomeDir(ownerId);
    const parent = path.dirname(homeDir);
    const homeName = path.basename(homeDir);
    if (!fs.existsSync(parent)) return [];

    const copies: BackupSafetyCopy[] = [];
    for (const entry of await fsp.readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const parsed = parseSafetyCopyName(entry.name);
        if (!parsed || parsed.homeName !== homeName) continue;
        const { bytes, truncated } = await measureSafetyCopy(path.join(parent, entry.name));
        copies.push({ name: entry.name, kind: parsed.kind, createdAt: parsed.at, bytes, truncated });
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

// Every folder beside the home that still stands for a state of it: the home itself and its other
// safety copies. Two copies can name the same object — a restore only rekeys the rows it carries —
// so an object one of them still points at is not garbage, whatever the folder being deleted says.
function foldersReferencingObjects(homeDir: string, deleting: string): string[] {
    const parent = path.dirname(homeDir);
    const homeName = path.basename(homeDir);
    const folders = [homeDir];
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const abs = path.join(parent, entry.name);
        if (abs === deleting) continue;
        if (parseSafetyCopyName(entry.name)?.homeName === homeName) folders.push(abs);
    }
    return folders;
}

// A remote mount keeps its bytes in a bucket, not in the home folder, so removing a safety copy has
// to take the objects only that copy points at with it. Anything the live home or another copy still
// names is left alone. A delete that does not land keeps the whole folder: it is the only record of
// which objects those bytes belong to, and losing it would orphan a home's worth of them in silence.
async function deleteRemoteObjects(folder: string, homeDir: string): Promise<void> {
    const settingsPath = path.join(folder, PATHS.SETTINGS);
    if (!fs.existsSync(settingsPath)) return;
    if (!fs.existsSync(homeDir)) {
        console.warn(`[backup] ${path.basename(folder)}: no live home to compare against, leaving its objects alone`);
        return;
    }
    const mounts = parseHomeMountSettings(await fsp.readFile(settingsPath, 'utf8'));
    if (!mounts) {
        console.warn(`[backup] ${path.basename(folder)}: ${PATHS.SETTINGS} is unreadable, leaving its objects alone`);
        return;
    }
    const referencing = foldersReferencingObjects(homeDir, folder);
    let failures = 0;
    for (const [id, mount] of Object.entries(mounts)) {
        if (mount.storageType !== 's3') continue;
        // settings.json came from an archive, so its keys are untrusted: a mount id that resolves
        // outside this folder would have this reading — and deleting the objects of — another home.
        const mountDir = resolveMountDir(folder, id);
        const copyDb = mountDir && path.join(mountDir, PATHS.DRIVE.METADATA_DB);
        if (!copyDb || !fs.existsSync(copyDb)) continue;
        // Never the server's current default: this folder's own credentials are the only ones that
        // name the bucket its objects are in.
        if (!mount.s3Config) {
            console.warn(`[backup] ${path.basename(folder)}: mount ${id} carries no S3 config, leaving its objects`);
            continue;
        }
        // Nothing to hold the copy's keys against: the mount is gone from the live home, and an
        // object it may still hold is not this delete's to judge.
        const liveMountDir = resolveMountDir(homeDir, id);
        if (!liveMountDir || !fs.existsSync(path.join(liveMountDir, PATHS.DRIVE.METADATA_DB))) continue;
        const referenced = new Set<string>();
        for (const dir of referencing) {
            const referencingMount = resolveMountDir(dir, id);
            const metadataPath = referencingMount && path.join(referencingMount, PATHS.DRIVE.METADATA_DB);
            if (metadataPath && fs.existsSync(metadataPath)) {
                for (const key of storageKeysIn(metadataPath)) referenced.add(key);
            }
        }

        const storage = createMountStorage(
            { id, name: id, storageType: 's3', isDefault: false, s3Config: mount.s3Config },
            mountDir,
        );
        for (const key of storageKeysIn(copyDb)) {
            if (referenced.has(key)) continue;
            try {
                // Both backends answer false for "not there" as well as for "could not", so the probe
                // is what tells a no-op — a failed restore's keys were staged, never uploaded — from
                // an outage, a 403, a rotated key.
                if ((await storage.exists(key)) && !(await storage.delete(key))) failures++;
            } catch (error) {
                console.error(`[backup] could not delete ${id}/${key}:`, error);
                failures++;
            }
        }
    }
    if (failures > 0) {
        throw new ApiError(503, `${failures} objects could not be deleted; the safety copy was kept`);
    }
}

export async function deleteSafetyCopy(folder: string, homeDir: string): Promise<void> {
    await deleteRemoteObjects(folder, homeDir);
    fs.rmSync(folder, { recursive: true, force: true });
    forgetSafetyCopySize(folder);
}
