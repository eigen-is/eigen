import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupArtifact } from '@workspace/lib/types/backup';
import { BACKUP_ARTIFACT_EXTENSION, parseBackupArtifactName } from '@workspace/lib/validation';
import { ApiError } from '../core';
import { writeTempWithHash } from '../drive/streaming';
import { readArtifactManifest, readSidecar, sidecarPath, writeSidecar } from './archive';
import { errnoOf } from './errors';
import { backupsDirPath, getBackupTempPath } from './paths';

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

// One answer for a name the backups folder already holds, wherever it is noticed: before the body
// is read, when the link lands, and when a filesystem with no links falls back to a rename.
const ALREADY_THERE = 'That artifact is already in the backups folder';

// Lands an uploaded body under its final name without overwriting an artifact that appeared while
// the body was streaming (another upload of the same name, or a job's own pack). A hard link fails
// when the name is taken, which is the point. Not every filesystem has links — a ./backups bind
// mount from CIFS/SMB rejects link outright — and there a check-then-rename is the best on offer.
function landUploadedArtifact(tempPath: string, artifactPath: string): void {
    try {
        fs.linkSync(tempPath, artifactPath);
        return;
    } catch (error) {
        const code = errnoOf(error);
        if (code === 'EEXIST') throw new ApiError(409, ALREADY_THERE);
        if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'EXDEV') throw error;
    }
    if (fs.existsSync(artifactPath)) throw new ApiError(409, ALREADY_THERE);
    fs.renameSync(tempPath, artifactPath);
}

// An uploaded archive, from a body the route has only checked the length of to a listed artifact
// with a sidecar: stream it into staging, land it under its final name, and read the manifest out
// of what landed. The whole sequence is here rather than in the route because every step of it can
// leave a file behind — the route hands over the body and gets back the name it can answer with.
export async function landUpload(body: ReadableStream<Uint8Array>, name: string, declared: number): Promise<void> {
    const { artifactPath, ownerId } = resolveArtifact(name);
    if (fs.existsSync(artifactPath)) throw new ApiError(409, ALREADY_THERE);

    // Staged next to the backups folder so the landing below is one filesystem operation: an
    // interrupted upload never leaves a short archive under a name the list would offer for
    // restore. writeTempWithHash is the stream-into-a-temp seam; its sha256 is incidental.
    const tempPath = getBackupTempPath(BACKUP_ARTIFACT_EXTENSION);
    try {
        const { size } = await writeTempWithHash(tempPath, body);
        // Content-Length is the client's word for it; the bytes are what count.
        if (size !== declared) throw new ApiError(400, 'Upload does not match its Content-Length');
        landUploadedArtifact(tempPath, artifactPath);
    } finally {
        fs.rmSync(tempPath, { force: true });
    }

    try {
        const manifest = await readArtifactManifest(artifactPath);
        if (manifest.ownerId !== ownerId) {
            throw new ApiError(400, `That archive is a backup of ${manifest.ownerId}, not of ${ownerId}`);
        }
        await writeSidecar(artifactPath, manifest, { status: 'unverified', failures: [] });
    } catch (error) {
        // An archive nothing can read is not an artifact; keeping it would put a row in the list
        // that every later action fails on. Only the file this request landed goes — the sidecar,
        // if there is one, belongs to whatever wrote it.
        fs.rmSync(artifactPath, { force: true });
        if (error instanceof ApiError) throw error;
        // Anything that is not a readable .tar.zst fails deep inside the decompressor.
        throw new ApiError(400, 'That upload is not a readable Eigen backup archive');
    }
}

export function deleteArtifact(artifactPath: string): void {
    fs.rmSync(artifactPath, { force: true });
    fs.rmSync(sidecarPath(artifactPath), { force: true });
}
