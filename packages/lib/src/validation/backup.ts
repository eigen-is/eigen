import { STORAGE_TYPE_LABELS } from '../constants/mount';
import {
    BACKUP_JOB_STATES,
    BACKUP_KINDS,
    BACKUP_LEVELS,
    BACKUP_REASONS,
    BACKUP_VERIFY_STATUSES,
    type BackupEntry,
    type BackupJob,
    type BackupLevel,
    type BackupManifest,
    type BackupReason,
    type BackupVerifyRecord,
    type ServerArchive,
    type ServerArchiveManifest,
    type ServerArchiveSidecar,
    type ServerArchiveUpload,
} from '../types/backup';
import type { MountConfig, S3Config } from '../types/mount';
import { parseOwnerId } from '../types/owner';

export { BACKUP_LEVELS, BACKUP_REASONS };

// One grammar for the names in the backups folder, so the pane, the upload route and the artifact
// list can never disagree about what an artifact is called.
export const BACKUP_ARTIFACT_EXTENSION = '.tar.zst';

export const BACKUP_HOME_PREFIX = 'home-';

// An owner id ends up in an artifact name and in a home folder a route resolves, so `/`, `..` and
// control characters are out of both by construction. A mount id becomes a path segment the same way.
const BACKUP_OWNER_ID_CHARS = '[A-Za-z0-9_-]+';
export const BACKUP_OWNER_ID = new RegExp(`^${BACKUP_OWNER_ID_CHARS}$`);

const BACKUP_MOUNT_ID = BACKUP_OWNER_ID;

// Artifact names and the safety copies a restore leaves beside a home folder read the same stamp.
export const BACKUP_STAMP_PATTERN = String.raw`(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})-(?<hours>\d{2})(?<minutes>\d{2})(?<seconds>\d{2})`;

export function parseBackupStamp(groups: Record<string, string | undefined>): Date | null {
    const at = new Date(
        `${groups['year']}-${groups['month']}-${groups['day']}T${groups['hours']}:${groups['minutes']}:${groups['seconds']}Z`,
    );
    return Number.isNaN(at.getTime()) ? null : at;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

// The home folder a restore moved aside (the state before it) and the incomplete folder a failed
// restore left behind; ./eigen restore keeps data/ aside under the first too. Nothing deletes either automatically.
export const PRE_RESTORE_SUFFIX = '.pre-restore-';
export const FAILED_RESTORE_SUFFIX = '.failed-restore-';

// UTC, so parseBackupStamp reads back the moment it was written.
export function buildBackupStamp(at: Date): string {
    return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
}

// Owner ids contain dashes, so the stamp is matched from the end and the owner id is what is left.
const ARTIFACT_EXTENSION_PATTERN = BACKUP_ARTIFACT_EXTENSION.replaceAll('.', String.raw`\.`);
const ARTIFACT_NAME = new RegExp(
    `^${BACKUP_HOME_PREFIX}(?<ownerId>${BACKUP_OWNER_ID_CHARS})-${BACKUP_STAMP_PATTERN}${ARTIFACT_EXTENSION_PATTERN}$`,
);

export function parseBackupArtifactName(name: string): { ownerId: string; at: Date } | null {
    const groups = ARTIFACT_NAME.exec(name)?.groups;
    if (!groups?.['ownerId']) return null;
    const at = parseBackupStamp(groups);
    return at ? { ownerId: groups['ownerId'], at } : null;
}

// The only manifest version this build writes and reads.
export const BACKUP_FORMAT_VERSION = 1;

// What ./eigen backup may start one for; only the schedule makes a scheduled archive.
export const ON_DEMAND_BACKUP_REASONS = ['manual', 'pre-update'] as const satisfies readonly Exclude<
    BackupReason,
    'scheduled'
>[];

// A whole-server archive: `server-{reason}-{level}-{stamp}.tar`, uncompressed because its members
// already are. Reason and level are in the name, so retention and the schedule read no archive.
export const SERVER_ARCHIVE_PREFIX = 'server-';
export const SERVER_ARCHIVE_EXTENSION = '.tar';

const SERVER_ARCHIVE_EXTENSION_PATTERN = SERVER_ARCHIVE_EXTENSION.replaceAll('.', String.raw`\.`);
const SERVER_ARCHIVE_NAME = new RegExp(
    `^${SERVER_ARCHIVE_PREFIX}(?<reason>${BACKUP_REASONS.join('|')})-(?<level>${BACKUP_LEVELS.join('|')})-${BACKUP_STAMP_PATTERN}${SERVER_ARCHIVE_EXTENSION_PATTERN}$`,
);

export function parseServerArchiveName(name: string): { reason: BackupReason; level: BackupLevel; at: Date } | null {
    const groups = SERVER_ARCHIVE_NAME.exec(name)?.groups;
    const reason = BACKUP_REASONS.find((candidate) => candidate === groups?.['reason']);
    const level = BACKUP_LEVELS.find((candidate) => candidate === groups?.['level']);
    if (!groups || !reason || !level) return null;
    const at = parseBackupStamp(groups);
    return at ? { reason, level, at } : null;
}

// The server archives among `names`, read, newest first. Any other name is left out.
export function parseServerArchiveNames(
    names: Iterable<string>,
): (Pick<ServerArchive, 'name' | 'reason' | 'level'> & { at: Date })[] {
    return [...names]
        .flatMap((name) => {
            const parsed = parseServerArchiveName(name);
            return parsed ? [{ name, ...parsed }] : [];
        })
        .sort((a, b) => b.at.getTime() - a.at.getTime());
}

// Undefined for text that is not JSON, which every check below refuses.
function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isKind(value: unknown): value is BackupManifest['kind'] {
    return BACKUP_KINDS.some((kind) => kind === value);
}

function isStorageType(value: string): value is MountConfig['storageType'] {
    return Object.hasOwn(STORAGE_TYPE_LABELS, value);
}

// An unknown level is refused rather than read as complete: a restore trusts this field to say so.
function isLevel(value: unknown): value is BackupLevel {
    return BACKUP_LEVELS.some((level) => level === value);
}

function isEntry(value: unknown): value is BackupEntry {
    return (
        typeof value === 'object' &&
        value !== null &&
        'path' in value &&
        typeof value.path === 'string' &&
        'bytes' in value &&
        typeof value.bytes === 'number' &&
        'sha256' in value &&
        typeof value.sha256 === 'string'
    );
}

// Without the id check a manifest could name `../../{someone else}/mounts/{id}`, which a restore
// would materialize into their live home.
function isMountSummary(value: unknown): value is BackupManifest['mounts'][number] {
    return (
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        typeof value.id === 'string' &&
        BACKUP_MOUNT_ID.test(value.id) &&
        'storageType' in value &&
        typeof value.storageType === 'string' &&
        isStorageType(value.storageType) &&
        'files' in value &&
        typeof value.files === 'number' &&
        'bytes' in value &&
        typeof value.bytes === 'number' &&
        (!('skipped' in value) || typeof value.skipped === 'string') &&
        (!('contents' in value) || value.contents === 'metadata')
    );
}

function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isServer(value: unknown): value is BackupManifest['server'] {
    return (
        typeof value === 'object' &&
        value !== null &&
        'domain' in value &&
        typeof value.domain === 'string' &&
        'orgId' in value &&
        typeof value.orgId === 'string'
    );
}

function isCounts(value: unknown): value is BackupManifest['counts'] {
    return (
        typeof value === 'object' &&
        value !== null &&
        'databases' in value &&
        typeof value.databases === 'number' &&
        'files' in value &&
        typeof value.files === 'number' &&
        'bytes' in value &&
        typeof value.bytes === 'number'
    );
}

function isManifest(value: unknown): value is BackupManifest {
    return (
        typeof value === 'object' &&
        value !== null &&
        'formatVersion' in value &&
        value.formatVersion === BACKUP_FORMAT_VERSION &&
        'kind' in value &&
        isKind(value.kind) &&
        'ownerId' in value &&
        typeof value.ownerId === 'string' &&
        'name' in value &&
        typeof value.name === 'string' &&
        'createdAt' in value &&
        typeof value.createdAt === 'string' &&
        'appVersion' in value &&
        typeof value.appVersion === 'string' &&
        'server' in value &&
        isServer(value.server) &&
        'counts' in value &&
        isCounts(value.counts) &&
        'mounts' in value &&
        Array.isArray(value.mounts) &&
        value.mounts.every(isMountSummary) &&
        'entries' in value &&
        Array.isArray(value.entries) &&
        value.entries.every(isEntry) &&
        (!('email' in value) || value.email === undefined || typeof value.email === 'string') &&
        (!('level' in value) || isLevel(value.level)) &&
        (!('warnings' in value) || isStringList(value.warnings))
    );
}

function isServerArchiveHome(value: unknown): value is ServerArchiveManifest['homes'][number] {
    return (
        typeof value === 'object' &&
        value !== null &&
        'ownerId' in value &&
        typeof value.ownerId === 'string' &&
        'kind' in value &&
        (value.kind === 'user' || value.kind === 'team') &&
        parseOwnerId(value.ownerId).type === value.kind &&
        'name' in value &&
        typeof value.name === 'string' &&
        (!('member' in value) || typeof value.member === 'string') &&
        (!('bytes' in value) || typeof value.bytes === 'number') &&
        (!('failed' in value) || typeof value.failed === 'string') &&
        (!('skipped' in value) || typeof value.skipped === 'string') &&
        (!('warnings' in value) || isStringList(value.warnings))
    );
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((item) => typeof item === 'string')
    );
}

// A JSON object of strings, as the data-epoch maps are kept on the server and in a tab; null for anything else.
export function parseStringRecord(text: string): Record<string, string> | null {
    const value = parseJson(text);
    return isStringRecord(value) ? value : null;
}

function isServerArchiveManifest(value: unknown): value is ServerArchiveManifest {
    return (
        typeof value === 'object' &&
        value !== null &&
        'formatVersion' in value &&
        value.formatVersion === BACKUP_FORMAT_VERSION &&
        'level' in value &&
        isLevel(value.level) &&
        'reason' in value &&
        BACKUP_REASONS.some((reason) => reason === value.reason) &&
        'createdAt' in value &&
        typeof value.createdAt === 'string' &&
        'appVersion' in value &&
        typeof value.appVersion === 'string' &&
        'domain' in value &&
        typeof value.domain === 'string' &&
        'entries' in value &&
        Array.isArray(value.entries) &&
        value.entries.every(isEntry) &&
        'homes' in value &&
        Array.isArray(value.homes) &&
        value.homes.every(isServerArchiveHome) &&
        'orphans' in value &&
        isStringList(value.orphans) &&
        'envFile' in value &&
        typeof value.envFile === 'boolean' &&
        'dkim' in value &&
        typeof value.dkim === 'boolean' &&
        'certs' in value &&
        typeof value.certs === 'boolean' &&
        'images' in value &&
        isStringRecord(value.images)
    );
}

// Whether an archive restores every home it lists whole: none failed and none was backed up with warnings. Only such
// an archive counts as good for local retention, the bucket's and ./eigen status, so warned nights never push out the
// last complete one. A record without a manifest has none.
export function isCompleteArchive(manifest: Pick<ServerArchiveManifest, 'homes'> | undefined): boolean {
    return manifest?.homes.every((home) => !home.failed && !home.warnings?.length) ?? false;
}

// The outer manifest's gate, beside the per-home one below. Null means "not a version 1 manifest of
// a whole-server archive".
export function parseServerArchiveManifest(text: string): ServerArchiveManifest | null {
    return checkServerArchiveManifest(parseJson(text));
}

function checkServerArchiveManifest(value: unknown): ServerArchiveManifest | null {
    if (!isServerArchiveManifest(value)) return null;
    // A home's member is read by that name, so it has to be one the entries vouch for.
    const members = new Set(value.entries.map((entry) => entry.path));
    return value.homes.every((home) => home.member === undefined || members.has(home.member)) ? value : null;
}

// The one gate every manifest passes through. Null means "not a version 1 Eigen backup manifest";
// the caller decides whether that is a failed verify or a rejected request.
export function parseBackupManifest(text: string): BackupManifest | null {
    const value = parseJson(text);
    return isManifest(value) ? value : null;
}

// Why an archive cannot restore a home on its own, or null when it can. A Light member of a
// whole-server archive holds no files and no mail; a mount marked metadata-only keeps its bodies in
// its bucket (an s3 mount at Full). Phrased to follow the archive's name.
export function incompleteReason(manifest: Pick<BackupManifest, 'level' | 'mounts'>): string | null {
    if (manifest.level === 'light') {
        return 'is a light backup: it holds no files and no mail, so it cannot restore an account on its own';
    }
    const metadataOnly = manifest.mounts.filter((summary) => summary.contents === 'metadata');
    if (metadataOnly.length === 0) return null;
    const ids = metadataOnly.map((summary) => summary.id).join(', ');
    return `holds only the metadata of mount ${ids}, not its files, so it cannot restore an account on its own`;
}

// A sidecar holds ISO strings; every reader of one wants the Date the API speaks.
function reviveDate(value: unknown): Date | undefined {
    const stamp = typeof value === 'string' ? new Date(value) : null;
    return stamp && !Number.isNaN(stamp.getTime()) ? stamp : undefined;
}

function parseVerifyRecord(verify: unknown): BackupVerifyRecord | null {
    if (typeof verify !== 'object' || verify === null) return null;
    const status = 'status' in verify ? BACKUP_VERIFY_STATUSES.find((candidate) => candidate === verify.status) : null;
    if (!status || !('failures' in verify) || !Array.isArray(verify.failures)) return null;
    if (verify.failures.some((failure) => typeof failure !== 'string')) return null;
    const checkedAt = 'checkedAt' in verify ? reviveDate(verify.checkedAt) : undefined;
    return { status, checkedAt, failures: verify.failures };
}

// The sidecar written next to an artifact: the same manifest plus the verify record.
export function parseBackupSidecar(text: string): { manifest: BackupManifest; verify: BackupVerifyRecord } | null {
    const value = parseJson(text);
    if (typeof value !== 'object' || value === null) return null;
    if (!('manifest' in value) || !isManifest(value.manifest)) return null;
    const verify = 'verify' in value ? parseVerifyRecord(value.verify) : null;
    return verify ? { manifest: value.manifest, verify } : null;
}

// The record beside a whole-server archive. Null means "not one this build wrote".
export function parseServerArchiveSidecar(text: string): ServerArchiveSidecar | null {
    const value = parseJson(text);
    if (typeof value !== 'object' || value === null) return null;
    const state = 'state' in value ? BACKUP_JOB_STATES.find((candidate) => candidate === value.state) : undefined;
    const startedAt = 'startedAt' in value ? reviveDate(value.startedAt) : undefined;
    if (!state || !startedAt) return null;
    const sidecar: ServerArchiveSidecar = { state, startedAt };
    if ('finishedAt' in value) {
        sidecar.finishedAt = reviveDate(value.finishedAt);
        if (!sidecar.finishedAt) return null;
    }
    if ('error' in value) {
        if (typeof value.error !== 'string') return null;
        sidecar.error = value.error;
    }
    if ('manifest' in value) {
        const manifest = checkServerArchiveManifest(value.manifest);
        if (!manifest) return null;
        sidecar.manifest = manifest;
    }
    if ('verify' in value) {
        const verify = parseVerifyRecord(value.verify);
        if (!verify) return null;
        sidecar.verify = verify;
    }
    if ('upload' in value) {
        const upload = parseUploadRecord(value.upload);
        if (!upload) return null;
        sidecar.upload = upload;
    }
    return sidecar;
}

function parseUploadRecord(value: unknown): ServerArchiveUpload | null {
    if (typeof value !== 'object' || value === null) return null;
    const state = 'state' in value ? BACKUP_JOB_STATES.find((candidate) => candidate === value.state) : undefined;
    const at = 'at' in value ? reviveDate(value.at) : undefined;
    if (!state || !at || !('key' in value) || typeof value.key !== 'string') return null;
    const upload: ServerArchiveUpload = { state, at, key: value.key };
    if ('error' in value) {
        if (typeof value.error !== 'string') return null;
        upload.error = value.error;
    }
    return upload;
}

// Whether the owner can upload an archive, for the Upload route, its button and ./eigen status: a verified archive,
// not a pre-update one (that stays on this server for ./eigen rollback), with no job still writing or uploading it,
// while a backup bucket is set. One the bucket holds already goes again.
export function canUploadServerArchive(
    { name, reason, record }: Pick<ServerArchive, 'name' | 'reason' | 'record'>,
    { uploadEnabled, jobs }: { uploadEnabled: boolean; jobs: readonly Pick<BackupJob, 'state' | 'artifact'>[] },
): boolean {
    return (
        uploadEnabled &&
        reason !== 'pre-update' &&
        record?.verify?.status === 'verified' &&
        !jobs.some((job) => job.state === 'running' && job.artifact === name)
    );
}

// `auth.json`: one array of rows per users3.db table. The columns are better-auth's and change with
// its version, so the check stops at "rows of a table" and Drizzle judges the columns on insert.
export function parseBackupAuthRows(text: string): Record<string, Record<string, unknown>[]> | null {
    const value = parseJson(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const rows: Record<string, Record<string, unknown>[]> = {};
    for (const [key, table] of Object.entries(value)) {
        if (!Array.isArray(table)) return null;
        for (const row of table) {
            if (typeof row !== 'object' || row === null || Array.isArray(row)) return null;
        }
        rows[key] = table;
    }
    return rows;
}

// `shares.json`: the restore keys these rows off the owner it is restoring, so only the target matters.
export function parseBackupShares(text: string): { targetIdentifier: string }[] | null {
    const value = parseJson(text);
    if (!Array.isArray(value)) return null;
    const shares: { targetIdentifier: string }[] = [];
    for (const row of value) {
        if (typeof row !== 'object' || row === null) return null;
        if (!('targetIdentifier' in row) || typeof row.targetIdentifier !== 'string') return null;
        shares.push({ targetIdentifier: row.targetIdentifier });
    }
    return shares;
}

function isS3Config(value: unknown): value is S3Config {
    return (
        typeof value === 'object' &&
        value !== null &&
        'endpoint' in value &&
        typeof value.endpoint === 'string' &&
        'bucket' in value &&
        typeof value.bucket === 'string' &&
        'accessKeyId' in value &&
        typeof value.accessKeyId === 'string' &&
        'secretAccessKey' in value &&
        typeof value.secretAccessKey === 'string'
    );
}

// The two facts an archive's or safety copy's `settings.json` says about where a mount's objects
// live. A mount whose entry is not those is left out, so the caller touches nothing of it.
export type BackupMountSettings = { storageType: MountConfig['storageType']; s3Config?: S3Config };

export function parseHomeMountSettings(text: string): Record<string, BackupMountSettings> | null {
    const value = parseJson(text);
    if (typeof value !== 'object' || value === null) return null;
    if (!('mounts' in value) || typeof value.mounts !== 'object' || value.mounts === null) return {};
    const mounts: Record<string, BackupMountSettings> = {};
    for (const [id, entry] of Object.entries(value.mounts)) {
        // The caller joins the id onto a folder path (see isMountSummary).
        if (!BACKUP_MOUNT_ID.test(id)) continue;
        if (typeof entry !== 'object' || entry === null) continue;
        if (!('storageType' in entry) || typeof entry.storageType !== 'string' || !isStorageType(entry.storageType)) {
            continue;
        }
        const s3Config = 's3Config' in entry && isS3Config(entry.s3Config) ? entry.s3Config : undefined;
        mounts[id] = { storageType: entry.storageType, s3Config };
    }
    return mounts;
}
