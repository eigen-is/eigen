import type { BackupEntry, BackupManifest, BackupVerifyRecord } from '../types/backup';
import type { S3Config } from '../types/mount';
import type { MountSettings } from '../types/settings';

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

// The annotations are what keep these lists from drifting from the shared unions.
const KINDS: readonly BackupManifest['kind'][] = ['user', 'team', 'server'];
const STORAGE_TYPES: readonly MountSettings['storageType'][] = ['local', 'local-key', 's3'];

function isKind(value: string): value is BackupManifest['kind'] {
    return KINDS.some((kind) => kind === value);
}

function isStorageType(value: string): value is MountSettings['storageType'] {
    return STORAGE_TYPES.some((type) => type === value);
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
function isMountSummary(value: unknown): boolean {
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
        (!('skipped' in value) || typeof value.skipped === 'string')
    );
}

function isManifest(value: unknown): value is BackupManifest {
    return (
        typeof value === 'object' &&
        value !== null &&
        'formatVersion' in value &&
        value.formatVersion === BACKUP_FORMAT_VERSION &&
        'kind' in value &&
        typeof value.kind === 'string' &&
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
        typeof value.server === 'object' &&
        value.server !== null &&
        'counts' in value &&
        typeof value.counts === 'object' &&
        value.counts !== null &&
        'mounts' in value &&
        Array.isArray(value.mounts) &&
        value.mounts.every(isMountSummary) &&
        'entries' in value &&
        Array.isArray(value.entries) &&
        value.entries.every(isEntry)
    );
}

// The one gate every manifest passes through. Null means "not a version 1 Eigen backup manifest";
// the caller decides whether that is a failed verify or a rejected request.
export function parseBackupManifest(text: string): BackupManifest | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    return isManifest(value) ? value : null;
}

function isStatus(value: string): value is BackupVerifyRecord['status'] {
    return value === 'unverified' || value === 'verified' || value === 'failed';
}

// The sidecar written next to an artifact: the same manifest plus the verify record.
export function parseBackupSidecar(text: string): { manifest: BackupManifest; verify: BackupVerifyRecord } | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    if (!('manifest' in value) || !isManifest(value.manifest)) return null;
    if (!('verify' in value) || typeof value.verify !== 'object' || value.verify === null) return null;
    const verify = value.verify;
    if (!('status' in verify) || typeof verify.status !== 'string' || !isStatus(verify.status)) return null;
    if (!('failures' in verify) || !Array.isArray(verify.failures)) return null;
    if (verify.failures.some((failure) => typeof failure !== 'string')) return null;
    // The file holds an ISO string; every reader of the record wants the Date the API speaks.
    const stamp = 'checkedAt' in verify && typeof verify.checkedAt === 'string' ? new Date(verify.checkedAt) : null;
    const checkedAt = stamp && !Number.isNaN(stamp.getTime()) ? stamp : undefined;
    return { manifest: value.manifest, verify: { status: verify.status, checkedAt, failures: verify.failures } };
}

// `auth.json`: one array of rows per users3.db table. The columns are better-auth's and change with
// its version, so the check stops at "rows of a table" and Drizzle judges the columns on insert.
export function parseBackupAuthRows(text: string): Record<string, Record<string, unknown>[]> | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
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
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
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
export type BackupMountSettings = { storageType: MountSettings['storageType']; s3Config?: S3Config };

export function parseHomeMountSettings(text: string): Record<string, BackupMountSettings> | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
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
