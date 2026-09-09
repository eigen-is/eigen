import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataRoot } from '../config/paths';
import { PATHS } from '../core';

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
    return `${buildHomeFolderName(ownerId)}-${buildStamp(at)}.tar.zst`;
}

// The home folder a restore moved aside (the state before it) and the incomplete folder a failed
// restore left behind. Nothing deletes either automatically; the admin pane lists and removes them.
export const PRE_RESTORE_SUFFIX = '.pre-restore-';
export const FAILED_RESTORE_SUFFIX = '.failed-restore-';

// buildStamp's shape as capture groups, so both names it appears in are read by one rule.
const STAMP_GROUPS = String.raw`(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})`;

function stampToDate(groups: string[]): Date | null {
    const [year, month, day, hours, minutes, seconds] = groups;
    const at = new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`);
    return Number.isNaN(at.getTime()) ? null : at;
}

// Owner ids are UUIDs or `team_{id}`, both of which contain dashes, so the timestamp is matched
// from the end and the owner id is whatever is left. The character class keeps `/` and `..` out
// of a name that later reaches the filesystem.
const ARTIFACT_NAME = new RegExp(String.raw`^home-([A-Za-z0-9_-]+)-${STAMP_GROUPS}\.tar\.zst$`);

export function parseArtifactName(name: string): { ownerId: string; at: Date } | null {
    const match = ARTIFACT_NAME.exec(name);
    if (!match) return null;
    const at = stampToDate(match.slice(2));
    return at ? { ownerId: match[1], at } : null;
}

// `{homeFolderName}{suffix}{stamp}`, plus the `-2` tail a restore appends when two of them land in
// the same second. The caller compares `homeName` against the home it asked about: that equality,
// not the character class, is what keeps a delete inside the right directory.
const SAFETY_COPY_SUFFIXES = [PRE_RESTORE_SUFFIX, FAILED_RESTORE_SUFFIX]
    .map((suffix) => suffix.replaceAll('.', String.raw`\.`))
    .join('|');
const SAFETY_COPY_NAME = new RegExp(String.raw`^(.+)(${SAFETY_COPY_SUFFIXES})${STAMP_GROUPS}(?:-\d+)?$`);

export function parseSafetyCopyName(
    name: string,
): { homeName: string; kind: 'pre-restore' | 'failed-restore'; at: Date } | null {
    const match = SAFETY_COPY_NAME.exec(name);
    if (!match) return null;
    const at = stampToDate(match.slice(3));
    if (!at) return null;
    return { homeName: match[1], kind: match[2] === PRE_RESTORE_SUFFIX ? 'pre-restore' : 'failed-restore', at };
}
