import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataRoot } from '../config/paths';

// Where backup artifacts live. Outside `data/` on purpose — the same place scripts/backup.sh
// writes, so one wipe of the data directory can never take the backups with it.
export function getBackupsDir(): string {
    const dir = process.env['EIGEN_BACKUPS_DIR'] || path.join(getDataRoot(), '..', 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getStagingRoot(): string {
    return path.join(getBackupsDir(), '.staging');
}

export function getBackupStagingDir(jobId: string): string {
    const dir = path.join(getStagingRoot(), jobId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Called on server start: a job interrupted by a restart leaves a half-written folder behind,
// and nothing ever resumes it.
export function wipeBackupStaging(): void {
    fs.rmSync(getStagingRoot(), { recursive: true, force: true });
}

// The folder snapshotHome writes, and the single top-level folder inside an artifact.
export function buildHomeFolderName(ownerId: string): string {
    return `home-${ownerId}`;
}

function pad(value: number, width: number): string {
    return String(value).padStart(width, '0');
}

export function buildArtifactName(ownerId: string, at: Date): string {
    const stamp = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}-${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}`;
    return `${buildHomeFolderName(ownerId)}-${stamp}.tar.zst`;
}

// Owner ids are UUIDs or `team_{id}`, both of which contain dashes, so the timestamp is matched
// from the end and the owner id is whatever is left. The character class keeps `/` and `..` out
// of a name that later reaches the filesystem.
const ARTIFACT_NAME = /^home-([A-Za-z0-9_-]+)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.tar\.zst$/;

export function parseArtifactName(name: string): { ownerId: string; at: Date } | null {
    const match = ARTIFACT_NAME.exec(name);
    if (!match) return null;
    const [, ownerId, year, month, day, hours, minutes, seconds] = match;
    const at = new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`);
    if (Number.isNaN(at.getTime())) return null;
    return { ownerId, at };
}
