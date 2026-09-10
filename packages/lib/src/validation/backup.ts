import type { BackupManifest, BackupVerifyRecord } from '../types/backup';
import type { S3Config } from '../types/mount';
import type { MountSettings } from '../types/settings';

// The only manifest version this build writes and reads.
export const BACKUP_FORMAT_VERSION = 1;

const KINDS = new Set(['user', 'team', 'server']);

function isEntry(value: unknown): boolean {
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

function isManifest(value: unknown): value is BackupManifest {
    return (
        typeof value === 'object' &&
        value !== null &&
        'formatVersion' in value &&
        value.formatVersion === BACKUP_FORMAT_VERSION &&
        'kind' in value &&
        typeof value.kind === 'string' &&
        KINDS.has(value.kind) &&
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
        'entries' in value &&
        Array.isArray(value.entries) &&
        value.entries.every(isEntry)
    );
}

// The one gate every manifest passes through, wherever it comes from: the folder a backup job just
// wrote, an artifact copied into the backups folder by hand, a sidecar left by an older build.
// Null means "this is not a version 1 Eigen backup manifest" — bad JSON and a wrong shape are the
// same answer to the caller, which decides whether that is a failed verify or a rejected request.
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
    const checkedAt = 'checkedAt' in verify && typeof verify.checkedAt === 'string' ? verify.checkedAt : undefined;
    return { manifest: value.manifest, verify: { status: verify.status, checkedAt, failures: verify.failures } };
}

// `auth.json`: one array of plain rows per users3.db table, keyed by table name. The columns are
// better-auth's and change with its version, so the shape check stops at "rows of a table" — the
// restore hands each row to Drizzle, which knows the columns.
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

// `shares.json`: the share_registry rows one user shared FROM. The restore keys them off the owner
// it is restoring, so only the target matters here.
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

function isStorageType(value: string): value is MountSettings['storageType'] {
    return value === 'local' || value === 'local-key' || value === 's3';
}

// The mounts a home's `settings.json` declares, as an archive or a safety copy carries it. Only the
// two facts that say where a mount's objects live are read: the backend, and the credentials of a
// remote one. A mount whose entry is not those is left out — the caller then knows nothing about it
// and touches nothing of it, which is the safe answer for a folder nobody is serving.
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
        if (typeof entry !== 'object' || entry === null) continue;
        if (!('storageType' in entry) || typeof entry.storageType !== 'string' || !isStorageType(entry.storageType)) {
            continue;
        }
        const s3Config = 's3Config' in entry && isS3Config(entry.s3Config) ? entry.s3Config : undefined;
        mounts[id] = { storageType: entry.storageType, s3Config };
    }
    return mounts;
}

// The name of an artifact in the backups folder, shared FE/BE: the admin pane refuses a file that
// is not one before it uploads anything, the upload route refuses it again, and the artifact list
// reads the ownerId back out of it. One grammar, so the two sides can never disagree about it.
export const BACKUP_ARTIFACT_EXTENSION = '.tar.zst';

// The character class an owner id may use. It ends up in an artifact name and in the home folder a
// route resolves, so `/`, `..` and control characters are out of both by construction.
export const BACKUP_OWNER_ID_CHARS = '[A-Za-z0-9_-]+';
export const BACKUP_OWNER_ID = new RegExp(`^${BACKUP_OWNER_ID_CHARS}$`);

// The timestamp shape in the backups folder as named groups: artifact names and the two safety
// copies a restore leaves beside a home folder all read the same.
export const BACKUP_STAMP_PATTERN = String.raw`(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})-(?<hours>\d{2})(?<minutes>\d{2})(?<seconds>\d{2})`;

export function parseBackupStamp(groups: Record<string, string | undefined>): Date | null {
    const at = new Date(
        `${groups['year']}-${groups['month']}-${groups['day']}T${groups['hours']}:${groups['minutes']}:${groups['seconds']}Z`,
    );
    return Number.isNaN(at.getTime()) ? null : at;
}

// Owner ids are UUIDs or `team_{id}`, both of which contain dashes, so the timestamp is matched
// from the end and the owner id is whatever is left.
const ARTIFACT_EXTENSION_PATTERN = BACKUP_ARTIFACT_EXTENSION.replaceAll('.', String.raw`\.`);
const ARTIFACT_NAME = new RegExp(
    `^home-(?<ownerId>${BACKUP_OWNER_ID_CHARS})-${BACKUP_STAMP_PATTERN}${ARTIFACT_EXTENSION_PATTERN}$`,
);

export function parseBackupArtifactName(name: string): { ownerId: string; at: Date } | null {
    const groups = ARTIFACT_NAME.exec(name)?.groups;
    if (!groups) return null;
    const at = parseBackupStamp(groups);
    return at ? { ownerId: groups['ownerId'] ?? '', at } : null;
}
