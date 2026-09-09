import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupArtifact, BackupManifest, BackupSafetyCopy } from '@workspace/lib/types/backup';
import { ApiError } from '../core';
import { readSidecar, sidecarPath } from './archive';
import { getBackupsDir, parseArtifactName, parseSafetyCopyName } from './paths';
import { resolveHomeDir } from './restore';

// A safety copy holds a whole home; its size is a line in a list, not an accounting figure, so the
// walk stops here and the number becomes a floor rather than taking a minute on a huge home.
const MAX_WALKED_FILES = 50_000;

function summarizeManifest(manifest: BackupManifest): BackupArtifact['manifest'] {
    const { kind, ownerId, email, name, appVersion, counts, mounts } = manifest;
    return { kind, ownerId, email, name, appVersion, counts, mounts };
}

function folderBytes(dir: string): number {
    let bytes = 0;
    let walked = 0;
    const stack = [dir];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (walked++ >= MAX_WALKED_FILES) return bytes;
            if (entry.isDirectory()) stack.push(path.join(current, entry.name));
            else if (entry.isFile()) bytes += fs.statSync(path.join(current, entry.name)).size;
        }
    }
    return bytes;
}

// One home's artifacts, newest first, read from the sidecars alone: opening an archive to answer a
// page load would decompress the whole thing. An artifact with no sidecar (one copied in by hand)
// lists as unverified with no manifest until a verify job writes one.
export async function listArtifacts(ownerId: string): Promise<BackupArtifact[]> {
    const dir = getBackupsDir();
    const artifacts: BackupArtifact[] = [];
    for (const name of fs.readdirSync(dir)) {
        const parsed = parseArtifactName(name);
        if (!parsed || parsed.ownerId !== ownerId) continue;
        const artifactPath = path.join(dir, name);
        const sidecar = await readSidecar(artifactPath);
        artifacts.push({
            name,
            bytes: fs.statSync(artifactPath).size,
            createdAt: parsed.at.toISOString(),
            manifest: sidecar ? summarizeManifest(sidecar.manifest) : null,
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
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const parsed = parseSafetyCopyName(entry.name);
        if (!parsed || parsed.homeName !== homeName) continue;
        copies.push({
            name: entry.name,
            kind: parsed.kind,
            createdAt: parsed.at.toISOString(),
            bytes: folderBytes(path.join(parent, entry.name)),
        });
    }
    return copies.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Every route that names an artifact resolves it here first: a name that is not one this server
// writes never reaches the filesystem. The owner id rides along because it is part of the name.
export function resolveArtifact(name: string): { artifactPath: string; ownerId: string } {
    const parsed = parseArtifactName(name);
    if (!parsed) throw new ApiError(400, 'Not a backup artifact name');
    return { artifactPath: path.join(getBackupsDir(), name), ownerId: parsed.ownerId };
}

export function deleteArtifact(artifactPath: string): void {
    fs.rmSync(artifactPath, { force: true });
    fs.rmSync(sidecarPath(artifactPath), { force: true });
}

// The one folder delete in the whole feature. The name has to parse as a safety copy AND name this
// owner's home folder; both hold before any path is built, let alone removed.
export async function resolveSafetyCopyPath(ownerId: string, name: string): Promise<string> {
    const homeDir = await resolveHomeDir(ownerId);
    const parsed = parseSafetyCopyName(name);
    if (!parsed || parsed.homeName !== path.basename(homeDir)) {
        throw new ApiError(400, 'Not a safety copy of this home');
    }
    return path.join(path.dirname(homeDir), name);
}
