import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupArtifact, BackupSafetyCopy } from '@workspace/lib/types/backup';
import { parseBackupArtifactName, parseHomeMountSettings } from '@workspace/lib/validation';
import { ApiError, PATHS } from '../core';
import { createMountStorage } from '../mount/helpers';
import { readSidecar, sidecarPath } from './archive';
import { backupsDirPath, parseSafetyCopyName, resolveHomeDir } from './paths';
import { flatStorageKey } from './snapshot-mount';

// A safety copy holds a whole home; its size is a line in a list, not an accounting figure, so the
// walk stops here and the number becomes a floor rather than taking a minute on a huge home.
const MAX_WALKED_FILES = 50_000;

// A safety copy never changes after the restore that made it, so it is measured once per process.
// The artifact list is refetched on every job poke — up to twice a second while a job runs — and
// walking a whole home on each of those would stall the event loop for every user on the server.
const measuredBytes = new Map<string, number>();

async function folderBytes(dir: string): Promise<number> {
    let bytes = 0;
    let walked = 0;
    const stack = [dir];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
        for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
            if (walked++ >= MAX_WALKED_FILES) return bytes;
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(abs);
            else if (entry.isFile()) bytes += (await fsp.stat(abs)).size;
        }
    }
    return bytes;
}

async function measureSafetyCopy(dir: string): Promise<number> {
    const known = measuredBytes.get(dir);
    if (known !== undefined) return known;
    const bytes = await folderBytes(dir);
    measuredBytes.set(dir, bytes);
    return bytes;
}

// One home's artifacts, newest first, read from the sidecars alone: opening an archive to answer a
// page load would decompress the whole thing. An artifact with no sidecar (one copied in by hand)
// lists as unverified with no manifest until a verify job writes one.
export async function listArtifacts(ownerId: string): Promise<BackupArtifact[]> {
    const dir = backupsDirPath();
    if (!fs.existsSync(dir)) return [];

    const artifacts: BackupArtifact[] = [];
    for (const name of await fsp.readdir(dir)) {
        const parsed = parseBackupArtifactName(name);
        if (!parsed || parsed.ownerId !== ownerId) continue;
        const artifactPath = path.join(dir, name);
        let bytes: number;
        try {
            bytes = (await fsp.stat(artifactPath)).size;
        } catch {
            continue; // deleted while this folder was being read
        }
        // Missing, unreadable, or not a sidecar all say the same thing to the list: nothing is known
        // about this archive yet, run a verify. One bad file must not blank the whole page.
        const sidecar = await readSidecar(artifactPath).catch(() => null);
        const manifest = sidecar?.manifest;
        artifacts.push({
            name,
            bytes,
            createdAt: parsed.at.toISOString(),
            manifest: manifest
                ? {
                      kind: manifest.kind,
                      ownerId: manifest.ownerId,
                      email: manifest.email,
                      name: manifest.name,
                      appVersion: manifest.appVersion,
                      counts: manifest.counts,
                      mounts: manifest.mounts,
                  }
                : null,
            verify: sidecar?.verify ?? { status: 'unverified', failures: [] },
        });
    }
    return artifacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
        copies.push({
            name: entry.name,
            kind: parsed.kind,
            createdAt: parsed.at.toISOString(),
            bytes: await measureSafetyCopy(path.join(parent, entry.name)),
        });
    }
    return copies.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Every route that names an artifact resolves it here first: a name that is not one this server
// writes never reaches the filesystem. The owner id rides along because it is part of the name.
export function resolveArtifact(name: string): { artifactPath: string; ownerId: string } {
    const parsed = parseBackupArtifactName(name);
    if (!parsed) throw new ApiError(400, 'Not a backup artifact name');
    // Reading or deleting an artifact never creates the backups folder; only a writer does.
    return { artifactPath: path.join(backupsDirPath(), name), ownerId: parsed.ownerId };
}

// Lands an uploaded body under its final name without overwriting an artifact that appeared while
// the body was streaming (another upload of the same name, or a job's own pack). A hard link fails
// when the name is taken, which is the point. Not every filesystem has links — a ./backups bind
// mount from CIFS/SMB rejects link outright — and there a check-then-rename is the best on offer.
export function landUploadedArtifact(tempPath: string, artifactPath: string): void {
    try {
        fs.linkSync(tempPath, artifactPath);
        return;
    } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : null;
        if (code === 'EEXIST') throw new ApiError(409, 'That artifact is already in the backups folder');
        if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'EXDEV') throw error;
    }
    if (fs.existsSync(artifactPath)) throw new ApiError(409, 'That artifact is already in the backups folder');
    fs.renameSync(tempPath, artifactPath);
}

export function deleteArtifact(artifactPath: string): void {
    fs.rmSync(artifactPath, { force: true });
    fs.rmSync(sidecarPath(artifactPath), { force: true });
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
        const mountDir = path.join(folder, PATHS.DRIVE.ROOT, id);
        const copyDb = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
        if (!fs.existsSync(copyDb)) continue;
        // Never the server's current default: this folder's own credentials are the only ones that
        // name the bucket its objects are in.
        if (!mount.s3Config) {
            console.warn(`[backup] ${path.basename(folder)}: mount ${id} carries no S3 config, leaving its objects`);
            continue;
        }
        // Nothing to hold the copy's keys against: the mount is gone from the live home, and an
        // object it may still hold is not this delete's to judge.
        if (!fs.existsSync(path.join(homeDir, PATHS.DRIVE.ROOT, id, PATHS.DRIVE.METADATA_DB))) continue;
        const referenced = new Set<string>();
        for (const dir of referencing) {
            const metadataPath = path.join(dir, PATHS.DRIVE.ROOT, id, PATHS.DRIVE.METADATA_DB);
            if (fs.existsSync(metadataPath)) for (const key of storageKeysIn(metadataPath)) referenced.add(key);
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
    measuredBytes.delete(folder);
}
