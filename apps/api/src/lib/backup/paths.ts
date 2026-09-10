import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupSafetyCopy } from '@workspace/lib/types/backup';
import { type ParsedOwnerId, parseOwnerId } from '@workspace/lib/types/owner';
import {
    BACKUP_ARTIFACT_EXTENSION,
    BACKUP_HOME_PREFIX,
    BACKUP_STAMP_PATTERN,
    parseBackupStamp,
} from '@workspace/lib/validation';
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

// Every job's scratch space lives under one folder, wiped at boot: `.staging` is spelled here and
// nowhere else.
export function getStagingRoot(): string {
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

function hasControlCharacter(text: string): boolean {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

// An archive comes from outside: its manifest, its mount trees and the settings.json of a folder it
// left behind all name paths this server then reads, opens and deletes. Anything that would leave
// `root` — absolute, a `..` hop, a control character, or a path that walks through a symlink — is
// refused before it reaches the filesystem. `root` is resolved to its real path here, so the
// comparison holds on a macOS /var → /private/var temp folder too. One spelling for both sides:
// verify judges an unpacked archive with it, and restore resolves every segment it is handed.
export function resolveInside(root: string, relPath: string): string | null {
    if (relPath === '' || path.isAbsolute(relPath) || hasControlCharacter(relPath)) return null;
    if (relPath.split(/[\\/]/).includes('..')) return null;
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
    const abs = path.resolve(realRoot, relPath);
    if (!abs.startsWith(`${realRoot}${path.sep}`)) return null;
    // Lexically inside is not enough: one symlinked directory along the way and the bytes read are
    // somebody else's.
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    return real.startsWith(`${realRoot}${path.sep}`) ? abs : null;
}

// The mount folder inside a home, for a mount id that came from outside (a manifest, a home's
// settings.json). Null when the id would leave the home — the caller refuses rather than touching
// another home's databases and files.
export function resolveMountDir(homeDir: string, mountId: string): string | null {
    return resolveInside(homeDir, `${PATHS.DRIVE.ROOT}/${mountId}`);
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

// The one file every reader of an archive starts from: snapshotHome writes it, verify judges the
// folder against it, restore reads the home out of it and the artifact list reads its sidecar copy.
export const ARCHIVE_MANIFEST_FILE = 'manifest.json';

export function archiveHomePath(relPath: string): string {
    return `${ARCHIVE_HOME_DIR}/${relPath}`;
}

export function archiveMountPath(mountId: string, relPath: string): string {
    return archiveHomePath(`${PATHS.DRIVE.ROOT}/${mountId}/${relPath}`);
}

// The folder snapshotHome writes, and the single top-level folder inside an artifact.
export function buildHomeFolderName(ownerId: string): string {
    return `${BACKUP_HOME_PREFIX}${ownerId}`;
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

// The one collision rule these names have: a stamp is a second wide, and two of a home's artifacts
// or safety copies can land inside one. The later one is stamped a second on, so every name in
// both grammars keeps exactly one shape.
function freeAt(at: Date, taken: (candidate: Date) => boolean): Date {
    let candidate = at;
    while (taken(candidate)) candidate = new Date(candidate.getTime() + 1000);
    return candidate;
}

// The name a new artifact takes. Without the rule above, two backups of one home inside a second
// would land on one name and the second would overwrite the first.
export function freeArtifactName(ownerId: string, at: Date): string {
    const free = freeAt(at, (candidate) =>
        fs.existsSync(path.join(backupsDirPath(), buildArtifactName(ownerId, candidate))),
    );
    return buildArtifactName(ownerId, free);
}

// The home folder a restore moved aside (the state before it) and the incomplete folder a failed
// restore left behind. Nothing deletes either automatically; the admin pane lists and removes them.
export const PRE_RESTORE_SUFFIX = '.pre-restore-';
export const FAILED_RESTORE_SUFFIX = '.failed-restore-';

// `{homeFolderName}{suffix}{stamp}`. The caller compares `homeName` against the home it asked
// about: that equality, not the character class, is what keeps a delete inside the right directory.
const SAFETY_COPY_SUFFIXES = [PRE_RESTORE_SUFFIX, FAILED_RESTORE_SUFFIX]
    .map((suffix) => suffix.replaceAll('.', String.raw`\.`))
    .join('|');
const SAFETY_COPY_NAME = new RegExp(`^(?<homeName>.+)(?<suffix>${SAFETY_COPY_SUFFIXES})${BACKUP_STAMP_PATTERN}$`);

// The folder a restore leaves beside the home, spelled in one place: `parseSafetyCopyName` reads
// back exactly what this writes.
export function buildSafetyCopyName(homeDir: string, kind: BackupSafetyCopy['kind'], stamp: string): string {
    return `${homeDir}${kind === 'pre-restore' ? PRE_RESTORE_SUFFIX : FAILED_RESTORE_SUFFIX}${stamp}`;
}

// The stamp the two safety copies of one restore share, under the same collision rule: a second
// restore of a home inside one second must not rename onto the first's copy (ENOTEMPTY, with the
// home already moved aside) AND must not hand a flat-key mount the fresh storage keys the first
// restore just wrote (see materializeMount).
export function freeSafetyCopyStamp(homeDir: string, at: Date): string {
    return buildStamp(
        freeAt(at, (candidate) => {
            const stamp = buildStamp(candidate);
            return (
                fs.existsSync(buildSafetyCopyName(homeDir, 'pre-restore', stamp)) ||
                fs.existsSync(buildSafetyCopyName(homeDir, 'failed-restore', stamp))
            );
        }),
    );
}

export function parseSafetyCopyName(
    name: string,
): { homeName: string; kind: BackupSafetyCopy['kind']; at: Date } | null {
    const groups = SAFETY_COPY_NAME.exec(name)?.groups;
    const homeName = groups?.['homeName'];
    if (!groups || !homeName) return null;
    const at = parseBackupStamp(groups);
    if (!at) return null;
    return { homeName, kind: groups['suffix'] === PRE_RESTORE_SUFFIX ? 'pre-restore' : 'failed-restore', at };
}

export type BackableOwner = ParsedOwnerId & { type: 'user' | 'team' };

// The two kinds of home an archive is of. An org home holds no databases and a guest home is
// disposable (guest-cleanup deletes them), so neither is backed up and neither can be restored —
// one spelling of that refusal, for the folder resolver and for the snapshot itself.
export function requireBackableOwner(owner: ParsedOwnerId): asserts owner is BackableOwner {
    if (owner.type !== 'user' && owner.type !== 'team') {
        throw new ApiError(400, `Cannot back up a ${owner.type} home`);
    }
}

// Where this owner's home folder lives. A guest is refused here as well: their home is disposable.
export async function resolveHomeDir(ownerId: string): Promise<string> {
    const owner = parseOwnerId(ownerId);
    if (owner.type === 'team') return getTeamDataPath(owner.id);
    requireBackableOwner(owner);
    const existing = await getUserById(owner.id);
    if (existing?.role === 'guest') throw new ApiError(400, 'Guest homes are not backed up');
    return getUserHomePath(owner.id);
}
