// The home archives in the backups folder: what the admin pane lists, how a name becomes a path, where an uploaded
// archive lands, the unpack with its room check, and what a delete takes with it. It also reads and writes the sidecar
// beside each archive, the manifest and verify result the list shows. The backup routes and jobs call it, and so does a
// restore. The record beside any archive, such as a server archive's, is written through writeRecord.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupArtifact, BackupManifest, BackupVerifyRecord } from '@workspace/lib/types/backup';
import { BACKUP_ARTIFACT_EXTENSION, parseBackupArtifactName, parseBackupSidecar } from '@workspace/lib/validation';
import { ApiError } from '../core';
import { errnoOf, writeTempWithHash } from '../storage';
import { ARCHIVE_FOLDER_MODE, ARCHIVE_MODE, extractArtifact, readArtifactManifest, withUnpackSlack } from './archive';
import { backupsDirPath, getBackupTempPath, roomShortfall, sidecarPath } from './paths';

// Read from the sidecars alone, since opening an archive would decompress the whole thing. One with no sidecar lists
// as unverified until a verify job writes one.
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
            // Deleted while this folder was being read.
            continue;
        }
        // A sidecar that does not read lists the archive as unverified, so one bad file does not blank the page.
        const sidecar = await readSidecar(artifactPath);
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
                      level: manifest.level,
                      mounts: manifest.mounts,
                      warnings: manifest.warnings,
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

// The same, for an artifact that has to be there already, such as one to delete, verify or restore.
export function requireArtifact(name: string): { artifactPath: string; ownerId: string } {
    const artifact = resolveArtifact(name);
    if (!fs.existsSync(artifact.artifactPath)) throw new ApiError(404, 'Artifact not found');
    return artifact;
}

// One answer for a name the backups folder already holds, wherever it is noticed: before the body
// is read, when the link lands, and when a filesystem with no links falls back to a rename.
const ALREADY_THERE = 'That artifact is already in the backups folder';

// Every step of this sequence can leave a file behind, so all of it is here and not in the route.
export async function landUpload(body: ReadableStream<Uint8Array>, name: string, declared: number): Promise<void> {
    const { artifactPath, ownerId } = resolveArtifact(name);
    if (fs.existsSync(artifactPath)) throw new ApiError(409, ALREADY_THERE);

    // Staged next to the backups folder so the landing is one filesystem operation, and an interrupted upload never
    // leaves a short archive under a name the list would offer for restore.
    const tempPath = getBackupTempPath(BACKUP_ARTIFACT_EXTENSION);
    try {
        // Made before the first byte, since the stream writes into the file it finds and keeps its mode.
        fs.writeFileSync(tempPath, '', { mode: ARCHIVE_MODE });
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
        // An archive nothing can read is no artifact. Only the file this request landed goes, not a sidecar someone
        // else wrote.
        fs.rmSync(artifactPath, { force: true });
        if (error instanceof ApiError) throw error;
        // Anything that is not a readable .tar.zst fails deep inside the decompressor.
        throw new ApiError(400, 'That upload is not a readable Eigen backup archive');
    }
}

// A hard link fails when the name is taken, so an artifact that appeared mid-stream is never overwritten.
// A CIFS/SMB bind mount rejects links outright, and there check-then-rename is the best on offer.
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

export function deleteArtifact(artifactPath: string): void {
    fs.rmSync(artifactPath, { force: true });
    fs.rmSync(sidecarPath(artifactPath), { force: true });
}

export async function writeSidecar(
    artifactPath: string,
    manifest: BackupManifest,
    verify: BackupVerifyRecord,
): Promise<void> {
    // Private like the archive: it names every file of the home, and ./eigen never reads it.
    await writeRecord(sidecarPath(artifactPath), { manifest, verify });
}

// Writes the JSON record beside an archive, with the archive's own mode. It is written in the staging folder and
// renamed into place, so a reader never sees half of one.
export async function writeRecord(target: string, value: unknown): Promise<void> {
    const tempPath = getBackupTempPath('.json');
    try {
        await fsp.writeFile(tempPath, JSON.stringify(value, null, 2), { mode: ARCHIVE_MODE });
    } catch (error) {
        fs.rmSync(tempPath, { force: true });
        throw error;
    }
    fs.renameSync(tempPath, target);
}

// Unpacks an artifact once the disk it lands on has room for the bytes its manifest counts. The manifest comes from the
// copy in the sidecar. Only an artifact without one is read for it, which decompresses the archive up to its manifest.
export async function unpackArtifact(artifactPath: string, targetDir: string): Promise<void> {
    const sidecar = await readSidecar(artifactPath);
    const { counts } = sidecar?.manifest ?? (await readArtifactManifest(artifactPath));
    fs.mkdirSync(targetDir, { recursive: true, mode: ARCHIVE_FOLDER_MODE });
    const needed = withUnpackSlack(counts.bytes);
    const shortfall = roomShortfall(`Unpacking ${path.basename(artifactPath)}`, needed, targetDir, 'its disk');
    if (shortfall) throw new ApiError(507, shortfall);
    await extractArtifact(artifactPath, targetDir);
}

// Null when there is no sidecar or it does not read. An artifact copied in by hand has none, and the list shows
// it as unverified until a verify job writes one.
async function readSidecar(
    artifactPath: string,
): Promise<{ manifest: BackupManifest; verify: BackupVerifyRecord } | null> {
    const text = await Bun.file(sidecarPath(artifactPath))
        .text()
        .catch(() => null);
    return text === null ? null : parseBackupSidecar(text);
}
