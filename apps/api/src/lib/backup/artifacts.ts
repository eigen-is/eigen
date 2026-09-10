import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupArtifact } from '@workspace/lib/types/backup';
import { parseBackupArtifactName } from '@workspace/lib/validation';
import { ApiError } from '../core';
import { readSidecar, sidecarPath } from './archive';
import { errnoOf } from './errors';
import { backupsDirPath } from './paths';

// The artifacts in the backups folder: what the admin pane lists, where an upload lands, and what a
// delete takes with it. The folders a restore leaves beside a home are safety-copy.ts.

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
            createdAt: parsed.at,
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
    return artifacts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
        const code = errnoOf(error);
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
