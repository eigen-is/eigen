import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupArtifact, BackupSafetyCopy } from '@workspace/lib/types/backup';
import type { MountSettings } from '@workspace/lib/types/settings';
import { ApiError, PATHS } from '../core';
import { createMountConfig, createMountStorage } from '../mount/helpers';
import { readSidecar, sidecarPath } from './archive';
import { backupsDirPath, parseArtifactName, parseSafetyCopyName, resolveHomeDir } from './paths';
import { readMountPathRows, storageKeyOf } from './snapshot-mount';

// The home's own settings file, which the archive and every safety copy carry as-is: the mount
// configuration a copy's stored objects have to be reached through.
const HOME_SETTINGS_FILE = 'settings.json';

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
        const parsed = parseArtifactName(name);
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
    const parsed = parseArtifactName(name);
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

// The storage keys one mount's metadata.db points at. Read-write on purpose: a WAL database whose
// owner is not holding it open has no -shm beside it, and a read-only open of one fails outright —
// which is exactly the shape of a home folder moved aside.
function storageKeysIn(metadataPath: string): Set<string> {
    const db = new Database(metadataPath, { readwrite: true, create: false });
    try {
        const rows = readMountPathRows(db);
        const byId = new Map(rows.map((row) => [row.id, row]));
        return new Set(rows.filter((row) => row.type === 'file').map((row) => storageKeyOf(row, byId, false)));
    } finally {
        db.close();
    }
}

// A remote mount keeps its bytes in a bucket, not in the home folder, so removing a safety copy has
// to take the objects only that copy points at with it. A restore gives every restored row a fresh
// key (lib/backup/restore.ts), so a live home and its safety copies never share one — and anything
// the live metadata.db still names is left alone whatever this folder says about it.
async function deleteRemoteObjects(folder: string, homeDir: string): Promise<void> {
    const settingsPath = path.join(folder, HOME_SETTINGS_FILE);
    if (!fs.existsSync(settingsPath)) return;
    if (!fs.existsSync(homeDir)) {
        console.warn(`[backup] ${path.basename(folder)}: no live home to compare against, leaving its objects alone`);
        return;
    }
    const settings: { mounts?: Record<string, MountSettings> } = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
    for (const [id, mountSettings] of Object.entries(settings.mounts ?? {})) {
        const config = createMountConfig(id, mountSettings);
        if (config.storageType !== 's3') continue;
        const mountDir = path.join(folder, PATHS.DRIVE.ROOT, id);
        const copyDb = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
        const liveDb = path.join(homeDir, PATHS.DRIVE.ROOT, id, PATHS.DRIVE.METADATA_DB);
        // Nothing to hold the copy's keys against: the mount is gone from the live home, and an
        // object it may still hold is not this delete's to judge.
        if (!fs.existsSync(copyDb) || !fs.existsSync(liveDb)) continue;
        const live = storageKeysIn(liveDb);
        const storage = createMountStorage(config, mountDir);
        for (const key of storageKeysIn(copyDb)) {
            if (live.has(key)) continue;
            // One object that will not go must not strand the rest, nor the folder: the admin asked
            // for it, and a stray object is recoverable garbage.
            await storage.delete(key).catch((error: unknown) => {
                console.error(`[backup] could not delete ${id}/${key}:`, error);
            });
        }
    }
}

export async function deleteSafetyCopy(folder: string, homeDir: string): Promise<void> {
    await deleteRemoteObjects(folder, homeDir).catch((error: unknown) => {
        console.error(`[backup] could not clean up the stored objects of ${path.basename(folder)}:`, error);
    });
    fs.rmSync(folder, { recursive: true, force: true });
    measuredBytes.delete(folder);
}
