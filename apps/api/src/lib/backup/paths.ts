import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseOwnerId } from '@workspace/lib/types/owner';
import { BACKUP_ARTIFACT_EXTENSION, BACKUP_STAMP_PATTERN, parseBackupStamp } from '@workspace/lib/validation';
import { getDataRoot, getTeamDataPath, getUserHomePath } from '../config/paths';
import { ApiError, PATHS } from '../core';
import { getUserById } from '../user/user';

// Where backup artifacts live. Outside `data/` on purpose — the same place scripts/backup.sh
// writes on the host, so one wipe of the data directory can never take the backups with it. In the
// container it is the `./backups` bind mount, named by EIGEN_BACKUPS_DIR.
export function backupsDirPath(): string {
    return process.env['EIGEN_BACKUPS_DIR'] || path.join(getDataRoot(), '..', 'backups');
}

// Only the writers ensure the folder: a server that has never made a backup should not grow one
// because an admin opened the pane, and in the container the path may not be writable at all.
// Readers take backupsDirPath() and treat a missing folder as an empty one.
export function getBackupsDir(): string {
    const dir = backupsDirPath();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getStagingRoot(): string {
    return path.join(backupsDirPath(), '.staging');
}

export function getBackupStagingDir(jobId: string): string {
    const dir = path.join(getStagingRoot(), jobId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Everything one job staged: the unpacked archive, and the restoring marker if it got that far.
export function wipeBackupStagingDir(jobId: string): void {
    fs.rmSync(path.join(getStagingRoot(), jobId), { recursive: true, force: true });
}

// Called on server start: a job interrupted by a restart leaves a half-written folder behind,
// and nothing ever resumes it. Creates nothing — at boot the backups folder may not exist yet.
export function wipeBackupStaging(): void {
    fs.rmSync(getStagingRoot(), { recursive: true, force: true });
}

// Scratch space for packing and unpacking: the half-written artifact, the decompressed tar. Under
// the staging root so a crash leaves nothing behind that the boot-time wipe does not clear, and on
// the same filesystem as the artifacts, so the last rename of a pack is atomic.
export function getBackupTempPath(suffix: string): string {
    return path.join(getBackupStagingDir('archive'), `${randomUUID()}${suffix}`);
}

// The layout inside a backup folder: `home/` mirrors the home directory one-for-one, and every
// mount keeps its metadata.db beside a `data/` tree of the files its paths table knows about.
// snapshotHome writes it and verifyFolder reads it back — one spelling for both.
export const ARCHIVE_HOME_DIR = 'home';

// The three things beside `home/` that a user's archive carries: the users3.db rows, the
// share-registry rows, and the avatar from data/server/avatars. A team archive has none of them.
export const ARCHIVE_AUTH_FILE = 'auth.json';
export const ARCHIVE_SHARES_FILE = 'shares.json';
export const ARCHIVE_AVATAR_DIR = 'avatar';

export function archiveHomePath(relPath: string): string {
    return `${ARCHIVE_HOME_DIR}/${relPath}`;
}

export function archiveMountPath(mountId: string, relPath: string): string {
    return archiveHomePath(`${PATHS.DRIVE.ROOT}/${mountId}/${relPath}`);
}

// The folder snapshotHome writes, and the single top-level folder inside an artifact.
export function buildHomeFolderName(ownerId: string): string {
    return `home-${ownerId}`;
}

function pad(value: number, width: number): string {
    return String(value).padStart(width, '0');
}

// The one timestamp shape in the backups folder: artifact names and the two safety copies a restore
// leaves beside a home folder all read the same.
export function buildStamp(at: Date): string {
    return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}-${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}`;
}

export function buildArtifactName(ownerId: string, at: Date): string {
    return `${buildHomeFolderName(ownerId)}-${buildStamp(at)}${BACKUP_ARTIFACT_EXTENSION}`;
}

// The home folder a restore moved aside (the state before it) and the incomplete folder a failed
// restore left behind. Nothing deletes either automatically; the admin pane lists and removes them.
export const PRE_RESTORE_SUFFIX = '.pre-restore-';
export const FAILED_RESTORE_SUFFIX = '.failed-restore-';

// `{homeFolderName}{suffix}{stamp}`, plus the `-2` tail a restore appends when two of them land in
// the same second. The caller compares `homeName` against the home it asked about: that equality,
// not the character class, is what keeps a delete inside the right directory.
const SAFETY_COPY_SUFFIXES = [PRE_RESTORE_SUFFIX, FAILED_RESTORE_SUFFIX]
    .map((suffix) => suffix.replaceAll('.', String.raw`\.`))
    .join('|');
const SAFETY_COPY_NAME = new RegExp(
    String.raw`^(?<homeName>.+)(?<suffix>${SAFETY_COPY_SUFFIXES})${BACKUP_STAMP_PATTERN}(?:-\d+)?$`,
);

// The folder a restore leaves beside the home, spelled in one place: `parseSafetyCopyName` reads
// back exactly what this writes.
export function buildSafetyCopyName(homeDir: string, kind: 'pre-restore' | 'failed-restore', stamp: string): string {
    return `${homeDir}${kind === 'pre-restore' ? PRE_RESTORE_SUFFIX : FAILED_RESTORE_SUFFIX}${stamp}`;
}

export function parseSafetyCopyName(
    name: string,
): { homeName: string; kind: 'pre-restore' | 'failed-restore'; at: Date } | null {
    const groups = SAFETY_COPY_NAME.exec(name)?.groups;
    if (!groups) return null;
    const at = parseBackupStamp(groups);
    if (!at) return null;
    return {
        homeName: groups['homeName'] ?? '',
        kind: groups['suffix'] === PRE_RESTORE_SUFFIX ? 'pre-restore' : 'failed-restore',
        at,
    };
}

// Where this owner's home folder lives. Org homes hold no databases and guest homes are disposable
// (guest-cleanup deletes them), so neither is backed up and neither can be restored.
export async function resolveHomeDir(ownerId: string): Promise<string> {
    const owner = parseOwnerId(ownerId);
    if (owner.type === 'team') return getTeamDataPath(owner.id);
    if (owner.type !== 'user') throw new ApiError(400, `Cannot back up a ${owner.type} home`);
    const existing = await getUserById(owner.id);
    if (existing?.role === 'guest') throw new ApiError(400, 'Guest homes are not backed up');
    return getUserHomePath(owner.id);
}
