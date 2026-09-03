import * as fs from 'node:fs';
import type { MountConfig, MountSettings } from '@workspace/lib/types';
import { EIGEN_DOCUMENT_TYPES } from '@workspace/lib/types/drive';
import { type SQL, sql } from 'drizzle-orm';
import { getS3Config } from '../config/server-settings';
import { ApiError } from '../core';

// Reserved: any case variant of `.trash` aliases the real trash dir (Mount.trashDir) on path-based mounts.
// Also checked on move (updatePath) so a legacy pre-guard row can't be re-parented onto the alias.
// NFKC before folding: APFS equates compatibility characters ('.traſh' with U+017F IS '.trash'),
// which plain toLowerCase misses.
export function isReservedName(name: string): boolean {
    return name.normalize('NFKC').toLowerCase() === '.trash';
}

// Control bytes (incl. NUL) are rejected in both names and WebDAV path segments — a name creatable
// via the API must stay reachable over WebDAV, which rejects this range per RFC 4918.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
export const CONTROL_CHARS = /[\x00-\x1f]/;

export function validateName(name: string): string {
    const hasControlChar = CONTROL_CHARS.test(name);
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || hasControlChar) {
        throw new ApiError(400, `Invalid file or folder name: "${name}"`);
    }
    // Store NFC so a decomposed (NFD) name still matches the NFC-normalized getChildByName/resolvePath lookups.
    const normalized = name.normalize('NFC');
    if (isReservedName(normalized)) {
        throw new ApiError(400, `"${name}" is a reserved name`);
    }
    // Filesystem ENAMETOOLONG is a byte limit, not a character limit.
    if (Buffer.byteLength(normalized, 'utf8') > 255) {
        throw new ApiError(400, 'File or folder name too long (max 255 bytes)');
    }
    return normalized;
}

// Subquery: ids of every eigendoc container (every EIGEN_DOCUMENT_TYPES row) and
// every path descended from one. Embedded as `parentId NOT IN (…)` to filter out
// container internals (data.db, media, embedded chats) — file rows the user
// never sees in the drive UI and shouldn't see in search.
export const docContainerDescendantIds = sql`
    WITH RECURSIVE doc_tree AS (
        SELECT id FROM paths
        WHERE type IN (${sql.join(
            EIGEN_DOCUMENT_TYPES.map((t) => sql`${t}`),
            sql`, `,
        )}) AND trashedAt IS NULL
        UNION ALL
        SELECT child.id FROM paths child INNER JOIN doc_tree dt ON child.parentId = dt.id
    )
    SELECT id FROM doc_tree
`;

// Subquery: `pathId` plus every ancestor up to the mount root. Embedded as `id IN (…)` so one
// query fetches a whole chain (resolveStoragePath walks it down, getBreadcrumb walks it up).
export function ancestorIds(pathId: string): SQL {
    return sql`
        WITH RECURSIVE ancestors AS (
            SELECT id, parentId FROM paths WHERE id = ${pathId}
            UNION ALL
            SELECT p.id, p.parentId FROM paths p JOIN ancestors a ON p.id = a.parentId
        )
        SELECT id FROM ancestors
    `;
}

// The v7 partial unique index (parentId, LOWER(name)) WHERE trashedAt IS NULL closes the concurrent
// same-name races the create INSERTs and rename/move/restore UPDATEs can't; translate its violation
// into the SAME 409 assertUniqueName raises (single-threaded callers pass that SELECT first, so only
// the race tail lands here). Match on the index name bun:sqlite puts in the message so an unrelated
// UNIQUE (the id PRIMARY KEY) still surfaces as a real error rather than a spurious 409.
export function rethrowDuplicateActiveName(e: unknown, name: string): never {
    if (e instanceof Error && e.message.includes(`index 'idx_paths_unique_active_name'`)) {
        throw new ApiError(409, `A file or folder named "${name}" already exists in this directory`);
    }
    throw e;
}

export function buildStorageKey(id: string, name: string): string {
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) {
        const ext = name.slice(dotIdx + 1).toLowerCase();
        if (ext.length > 0 && ext.length <= 12) {
            return `${id}.${ext}`;
        }
    }
    return id;
}

// A document working copy must be a real SQLite db. The 16-byte magic header is the cheapest proof;
// a 0-byte or partial download (an empty/failed S3 GET) fails it. Used to refuse opening such a file
// as a fresh empty doc and re-uploading it over good stored bytes (the 2026-06-08 data loss), and by
// the upload queue to refuse PUTting a corrupted staged copy over the good stored object.
export function isSqliteFile(filePath: string): boolean {
    let fd: number | null = null;
    try {
        fd = fs.openSync(filePath, 'r');
        const header = Buffer.alloc(16);
        const read = fs.readSync(fd, header, 0, 16, 0);
        // SQLite magic: the 15 ASCII bytes "SQLite format 3" followed by a NUL terminator.
        return read === 16 && header.toString('latin1', 0, 15) === 'SQLite format 3' && header[15] === 0;
    } catch {
        return false;
    } finally {
        if (fd !== null) fs.closeSync(fd);
    }
}

// A recovered temp is the live working copy after an unclean shutdown: it should be the stored db
// (plus any unsynced writes), never a fraction of it. Refuse it if it isn't a valid SQLite, or if it
// has collapsed far below the last-known stored size (a tiny fresh-init db where a multi-MB doc was) —
// either signals corrupt/empty bytes that must not be adopted and re-uploaded over the good object.
const RECOVERY_COLLAPSE_FLOOR_BYTES = 64 * 1024;
const RECOVERY_COLLAPSE_RATIO = 0.5;
export function isViableRecoveryTemp(tempPath: string, knownSize: number): boolean {
    if (!isSqliteFile(tempPath)) return false;
    const tempSize = fs.statSync(tempPath).size;
    return !(knownSize >= RECOVERY_COLLAPSE_FLOOR_BYTES && tempSize < knownSize * RECOVERY_COLLAPSE_RATIO);
}

const DEFAULT_MOUNT_NAME = 'My Drive';
const DEFAULT_MOUNT_ID = 'default';

export function createDefaultMountConfig(): MountConfig {
    return { id: DEFAULT_MOUNT_ID, name: DEFAULT_MOUNT_NAME, storageType: 'local', isDefault: true };
}

export function createMountConfig(id: string, settings: MountSettings): MountConfig {
    return {
        id,
        name: settings.name ?? (id === DEFAULT_MOUNT_ID ? DEFAULT_MOUNT_NAME : id),
        storageType: settings.storageType,
        isDefault: id === DEFAULT_MOUNT_ID,
        maxSizeMB: settings.maxSizeMB,
        s3Config: settings.s3Config ?? (settings.storageType === 's3' ? getS3Config() : undefined),
    };
}
