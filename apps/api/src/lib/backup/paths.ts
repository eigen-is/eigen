// Where backups live and what they are called. It builds the names of archives, home folders and safety copies,
// and the places inside an archive where each part of a home goes. It makes the private staging folder every job
// works in. It also resolves a path inside a folder without ever leaving it, which every restore step needs before
// it touches the disk.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { formatFileSize } from '@workspace/lib/format';
import type { BackupLevel, BackupReason, BackupSafetyCopy } from '@workspace/lib/types/backup';
import type { ParsedOwnerId } from '@workspace/lib/types/owner';
import {
    BACKUP_ARTIFACT_EXTENSION,
    BACKUP_HOME_PREFIX,
    BACKUP_STAMP_PATTERN,
    buildBackupStamp,
    FAILED_RESTORE_SUFFIX,
    NO_CONTROL_PATTERN,
    PRE_RESTORE_SUFFIX,
    parseBackupStamp,
    SERVER_ARCHIVE_EXTENSION,
    SERVER_ARCHIVE_PREFIX,
} from '@workspace/lib/validation';
import { CERT_FILES, CERTS_DIR, DKIM_DIR, getDataRoot, PATHS, SERVER_DIR } from '../config/paths';
import { ApiError } from '../core/errors';

// Where backup artifacts live. Outside `data/` on purpose, so one wipe of the data directory can never
// take the backups with it. In the container it is the `./backups` bind mount, named by EIGEN_BACKUPS_DIR.
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

// Every job's scratch space lives under one folder in the backups folder, wiped at boot.
export const STAGING_DIR = '.staging';
// A job stages a home unpacked, auth rows and keys included, with the umask's modes. The backups folder stays
// listable for ./eigen, so the staging folders are what keep other users of the host out.
const STAGING_MODE = 0o700;

export function getStagingRoot(): string {
    return path.join(backupsDirPath(), STAGING_DIR);
}

// The chmod closes a staging root that was made with the umask's mode, such as an older build's.
export function getBackupStagingDir(jobId: string): string {
    // Makes backups/ first with its own mode, or the recursive mkdir below would make it 0700 too.
    getBackupsDir();
    const root = getStagingRoot();
    fs.mkdirSync(root, { recursive: true, mode: STAGING_MODE });
    fs.chmodSync(root, STAGING_MODE);
    const dir = path.join(root, jobId);
    fs.mkdirSync(dir, { recursive: true, mode: STAGING_MODE });
    return dir;
}

// Everything one job staged: the unpacked archive, and the restoring marker if it got that far.
export async function wipeBackupStagingDir(jobId: string): Promise<void> {
    await fsp.rm(path.join(getStagingRoot(), jobId), { recursive: true, force: true });
}

// Called on server start: a job interrupted by a restart leaves a half-written folder behind,
// and nothing ever resumes it. It creates nothing, because at boot the backups folder may not exist yet.
export function wipeBackupStaging(): void {
    fs.rmSync(getStagingRoot(), { recursive: true, force: true });
}

// Scratch space for packing: the half-written artifact, the half-written sidecar. Under
// the staging root so a crash leaves nothing behind that the boot-time wipe does not clear, and on
// the same filesystem as the artifacts, so the last rename of a pack is atomic.
export function getBackupTempPath(suffix: string): string {
    return path.join(getBackupStagingDir('archive'), `${crypto.randomUUID()}${suffix}`);
}

const NO_CONTROL = new RegExp(NO_CONTROL_PATTERN);

// An archive comes from outside: its manifest, its mount trees and the settings.json of a folder it
// left behind all name paths this server then reads, opens and deletes. Anything that would leave
// `root` is refused before it reaches the filesystem, such as an absolute path, a `..` hop, a control
// character, or a path that walks through a symlink. `root` is resolved to its real path here, so the
// comparison holds on a macOS temp folder too, where /var is /private/var.
export function resolveInside(root: string, relPath: string): string | null {
    if (relPath === '' || path.isAbsolute(relPath) || !NO_CONTROL.test(relPath)) return null;
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
// settings.json). Null when the id would leave the home, so the caller refuses rather than touching
// another home's databases and files.
export function resolveMountDir(homeDir: string, mountId: string): string | null {
    return resolveInside(homeDir, `${PATHS.DRIVE.ROOT}/${mountId}`);
}

// The same folder, refusing a mount id that would leave the home.
export function requireMountDir(homeDir: string, mountId: string): string {
    const mountDir = resolveMountDir(homeDir, mountId);
    if (!mountDir) throw new ApiError(400, `${mountId} is not a mount of this home`);
    return mountDir;
}

// The layout inside a backup folder: `home/` mirrors the home directory one-for-one, and every
// mount keeps its metadata.db beside a `data/` tree of the files its paths table knows about.
export const ARCHIVE_HOME_DIR = 'home';

// The three things beside `home/` that a user's archive carries: the users3.db rows, the
// share-registry rows, and the avatar from data/server/avatars. A team archive has none of them.
export const ARCHIVE_AUTH_FILE = 'auth.json';
export const ARCHIVE_SHARES_FILE = 'shares.json';
export const ARCHIVE_AVATAR_DIR = 'avatar';

// The list of what an archive holds, which every reader of an archive starts from.
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

export function buildArtifactName(ownerId: string, at: Date): string {
    return `${buildHomeFolderName(ownerId)}-${buildBackupStamp(at)}${BACKUP_ARTIFACT_EXTENSION}`;
}

// The layout of a whole-server archive beside its manifest.json: one per-home artifact per home, the
// server folder packed like a home, and the install files the API may be unable to read.
const SERVER_ARCHIVE_HOMES_DIR = 'homes';
export const SERVER_ARCHIVE_SERVER_MEMBER = 'server.tar.zst';
export const SERVER_ARCHIVE_ENV_MEMBER = '.env.production';

// The install folders an archive carries beside its members, under the name they have in data/: the DKIM key with
// whatever its folder holds, the TLS certificate as its two files or not at all. `field` is the manifest's flag.
export const INSTALL_FOLDERS: { dir: string; field: 'dkim' | 'certs'; what: string; names?: readonly string[] }[] = [
    { dir: DKIM_DIR, field: 'dkim', what: 'DKIM' },
    { dir: CERTS_DIR, field: 'certs', what: 'TLS', names: Object.values(CERT_FILES) },
];

export function buildServerArchiveName(reason: BackupReason, level: BackupLevel, at: Date): string {
    return `${SERVER_ARCHIVE_PREFIX}${reason}-${level}-${buildBackupStamp(at)}${SERVER_ARCHIVE_EXTENSION}`;
}

// The per-home artifact name with the archive's stamp, so a member copied out into the backups
// folder is an ordinary artifact of that home.
export function buildHomeMemberName(ownerId: string, at: Date): string {
    return `${SERVER_ARCHIVE_HOMES_DIR}/${buildArtifactName(ownerId, at)}`;
}

// The single top-level folder inside server.tar.zst. It mirrors data/: `server/` and `org/`.
export function buildServerFolderName(at: Date): string {
    return `server-${buildBackupStamp(at)}`;
}

export function archiveServerPath(relPath: string): string {
    return `${SERVER_DIR}/${relPath}`;
}

// The name a new artifact takes. Without `nextFreeTime` below, two backups of one home inside a second
// would land on one name and the second would overwrite the first.
export function freeArtifactName(ownerId: string, at: Date): string {
    const free = nextFreeTime(at, (candidate) =>
        fs.existsSync(path.join(backupsDirPath(), buildArtifactName(ownerId, candidate))),
    );
    return buildArtifactName(ownerId, free);
}

// Beside the archive, so the list and retention never open one. A home artifact's caches its manifest
// and last verify; a server archive's is its job's record, which a refused attempt leaves with no archive.
export const SIDECAR_SUFFIX = '.manifest.json';
export const SERVER_SIDECAR_SUFFIX = '.json';
// Beside a partial archive in the bucket, which may outlive this box's record of it.
export const BUCKET_PARTIAL_SUFFIX = '.partial';

export function sidecarPath(artifactPath: string): string {
    return `${artifactPath}${SIDECAR_SUFFIX}`;
}

export function serverSidecarPath(archivePath: string): string {
    return `${archivePath}${SERVER_SIDECAR_SUFFIX}`;
}

// The stamp a new whole-server archive takes, under the same rule; its members carry it too. A
// refused attempt leaves only its sidecar, and that name is taken as well.
export function freeServerArchiveAt(reason: BackupReason, level: BackupLevel, at: Date): Date {
    return nextFreeTime(at, (candidate) => {
        const archivePath = path.join(backupsDirPath(), buildServerArchiveName(reason, level, candidate));
        return fs.existsSync(archivePath) || fs.existsSync(serverSidecarPath(archivePath));
    });
}

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
// home already moved aside). It also must not hand a flat-key mount the fresh storage keys the first
// restore just wrote, which materializeMount derives from the stamp.
export function freeSafetyCopyStamp(homeDir: string, at: Date): string {
    return buildBackupStamp(
        nextFreeTime(at, (candidate) => {
            const stamp = buildBackupStamp(candidate);
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

// The one collision rule these names have: a stamp is a second wide, and two of a home's artifacts
// or safety copies can land inside one. The later one is stamped a second on, so every name in
// both grammars keeps exactly one shape.
export function nextFreeTime(at: Date, taken: (candidate: Date) => boolean): Date {
    let candidate = at;
    while (taken(candidate)) candidate = new Date(candidate.getTime() + 1000);
    return candidate;
}

// Why the disk of `dir` has no room for `needed` bytes, or null. Every backup's and stage's room check words
// its refusal this way.
export function roomShortfall(what: string, needed: number, dir: string, where: string): string | null {
    const { bavail, bsize } = fs.statfsSync(dir);
    const free = bavail * bsize;
    if (needed <= free) return null;
    return `${what} needs up to ${formatFileSize(needed)}; ${where} has ${formatFileSize(free)} free`;
}

export type BackableOwner = ParsedOwnerId & { type: 'user' | 'team' };

// The two kinds of home an archive is of. An org home holds no databases and a guest home is
// disposable (guest cleanup deletes them), so neither is backed up and neither can be restored.
export function requireBackableOwner(owner: ParsedOwnerId): asserts owner is BackableOwner {
    if (owner.type !== 'user' && owner.type !== 'team') {
        throw new ApiError(400, `Not a user or team home (${owner.type})`);
    }
}
