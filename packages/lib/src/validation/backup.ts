import type { BackupManifest, BackupVerifyRecord } from '../types/backup';

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
