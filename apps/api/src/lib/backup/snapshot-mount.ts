import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry } from '@workspace/lib/types/backup';
import { type DrivePathType, isCollabType, isDocumentType } from '@workspace/lib/types/drive';
import { COMMENT_INDEX_DB_CONFIG } from '../chat/comment-db-config';
import { CHAT_ROOM_DB_CONFIG } from '../chat/db-config';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import type { DatabaseConfig, SchemaType } from '../core';
import { buildStorageKey } from '../mount/helpers';
import type { Mount } from '../mount/mount';
import { paths } from '../mount/schema';
import { stageManagedDbCopy } from '../versioning/snapshot';
import { VERSIONS_FOLDER_NAME } from '../versioning/versions-folder';
import { captureFile, captureWrittenFile } from './capture';
import type { SnapshotProgress } from './snapshot-home';

export type MountPathRow = Pick<
    typeof paths.$inferSelect,
    'id' | 'file' | 'name' | 'type' | 'parentId' | 'trashedFrom'
>;

// The databases a mount owns inside an archive: a container's data.db/comments.db and the versions/
// snapshots of one, each with the container type behind it.
export type ManagedArchiveDatabase = {
    // Relative to the mount's data/ folder in the archive.
    path: string;
    // The container's own data.db — the one a Yjs decode can be run on. False for comments.db and
    // for a versions/ snapshot.
    isContainerData: boolean;
    containerType: DrivePathType;
    // The schema this file was written against, so a restore can tell a database from a newer server
    // (which ManagedDatabase would then refuse to open) before it hands the home back.
    config: DatabaseConfig<SchemaType>;
    // The row this file belongs to, so a restore can put it back at the key its mount will look for.
    row: MountPathRow;
};

// The two databases a container owns; a mount never manages any other (see mount/document-db.ts).
const CONTAINER_DB_NAMES = new Set(['data.db', 'comments.db']);

// Which schema a managed file carries: a comment index, or the container's own document database —
// Yjs for every collab type, chat's own for a chat room. A versions/ snapshot is a copy of the
// container's data.db, so it answers the same.
function configOf(name: string, containerType: DrivePathType): DatabaseConfig<SchemaType> {
    if (name === 'comments.db') return COMMENT_INDEX_DB_CONFIG;
    return isCollabType(containerType) ? COLLAB_DB_CONFIG : CHAT_ROOM_DB_CONFIG;
}

// Ancestors of `row`, nearest first. Guarded against a corrupt parentId cycle, which would
// otherwise spin forever on a table the backup does not get to trust.
function* ancestors(row: MountPathRow, byId: Map<string, MountPathRow>): Generator<MountPathRow> {
    const seen = new Set<string>([row.id]);
    let current = row.parentId ? byId.get(row.parentId) : undefined;
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        yield current;
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
}

// Where a row's bytes go inside the archive: the storage key it WOULD have on a `local` mount —
// the name chain from the root, with a trash root at `.trash/{id}.{ext}` as trashPath spells it.
// Deriving it from metadata.db instead of the mount's own keys is what makes the archive
// storage-independent: local-key and s3 mounts store flat keys, and restore re-derives whichever
// shape the target mount needs. Exported for restore, which reads the same tree back.
export function archivePath(row: MountPathRow, byId: Map<string, MountPathRow>): string {
    const segment = (r: MountPathRow) => (r.trashedFrom ? `.trash/${buildStorageKey(r.id, r.name)}` : r.name);
    const segments = [segment(row)];
    for (const parent of ancestors(row, byId)) {
        if (parent.parentId === null) break; // the mount root contributes no segment
        segments.unshift(segment(parent));
    }
    return segments.join('/');
}

// Mirrors Mount.resolveStoragePath / getStorageKey, resolved from the tree we already hold rather
// than one recursive-CTE query per file. Exported for restore, which puts every file back at the
// key the restored mount will look for it under — one spelling of the rule for both directions.
export function storageKeyOf(row: MountPathRow, byId: Map<string, MountPathRow>, isPathBased: boolean): string {
    if (!isPathBased) return row.file || row.id;
    const segments = row.file ? [row.file] : [];
    for (const parent of ancestors(row, byId)) {
        if (parent.parentId === null) break;
        if (parent.file) segments.unshift(parent.file);
    }
    return segments.join('/');
}

// The databases the mount itself manages: a container's data.db/comments.db, and the versions/
// snapshots of one. Returns the container to lock while copying, or null for anything else — a
// user's own upload that happens to be SQLite must round-trip byte-identical.
function managedDbContainer(row: MountPathRow, byId: Map<string, MountPathRow>): MountPathRow | null {
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    if (!parent) return null;
    if (parent.name === VERSIONS_FOLDER_NAME) {
        const container = parent.parentId ? byId.get(parent.parentId) : undefined;
        return container && isDocumentType(container.type) ? container : null;
    }
    return CONTAINER_DB_NAMES.has(row.name) && isDocumentType(parent.type) ? parent : null;
}

// The rows of an archived metadata.db, in the shape every reader of one wants. The columns are
// listed once here rather than in each caller's own SELECT (verify, restore).
export function readMountPathRows(db: Database): MountPathRow[] {
    return db.query<MountPathRow, []>('SELECT id, file, name, type, parentId, trashedFrom FROM paths').all();
}

// The same rule, read back from an archived metadata.db: which of a mount's archived files are
// Eigen's own databases. Verify needs it to know what it may open — a user's own SQLite upload is
// stored byte-identical, journal header and all, and opening it is not verify's business.
export function listManagedDatabases(rows: MountPathRow[]): ManagedArchiveDatabase[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const found: ManagedArchiveDatabase[] = [];
    for (const row of rows) {
        if (row.type !== 'file') continue;
        const container = managedDbContainer(row, byId);
        if (!container) continue;
        // managedDbContainer returns the parent for a container database and the grandparent for a
        // version snapshot, which is what tells a live data.db from an archived copy of one.
        const isContainerData = container.id === row.parentId && row.name === 'data.db';
        found.push({
            path: archivePath(row, byId),
            isContainerData,
            containerType: container.type,
            config: configOf(row.name, container.type),
            row,
        });
    }
    return found;
}

// A WAL-mode database cannot be opened at all — not even read-only — without the `-wal` beside it,
// and an archive carries main files only: the journals belong to the running server. Rewrite the
// copy's journal mode so every database in the archive stands alone. Only reached for mount-owned
// databases, whose copied bytes are already whole (the live handle is captured with VACUUM INTO,
// and a closed one was checkpointed TRUNCATE by ManagedDatabase.close). A corrupt container must
// not cost the user the rest of the backup, so a failure keeps the copied bytes and verify's
// quick_check flags them.
function normalizeArchiveDatabase(destPath: string): void {
    try {
        const db = new Database(destPath, { readwrite: true, create: false });
        try {
            db.run('PRAGMA journal_mode = DELETE');
        } finally {
            db.close();
        }
    } catch (e) {
        console.warn(`[backup] could not reset the journal mode of ${destPath}:`, e);
    }
    fs.rmSync(`${destPath}-wal`, { force: true });
    fs.rmSync(`${destPath}-shm`, { force: true });
}

// Copy every file the mount's paths table knows about into `targetDir`. Walking the table rather
// than the filesystem is what keeps `thumbs/`, `tmp/` and `staging/` out and `.trash/` + `versions/`
// in, on every backend.
export async function snapshotMountData(
    mount: Mount,
    targetDir: string,
    relPrefix: string,
    onProgress: SnapshotProgress,
): Promise<BackupEntry[]> {
    const rows = await mount.db
        .select({
            id: paths.id,
            file: paths.file,
            name: paths.name,
            type: paths.type,
            parentId: paths.parentId,
            trashedFrom: paths.trashedFrom,
        })
        .from(paths)
        .all();
    const byId = new Map(rows.map((row) => [row.id, row]));

    const fileRows = rows.filter((row) => row.type === 'file');
    const entries: BackupEntry[] = [];
    for (const [index, row] of fileRows.entries()) {
        const relPath = archivePath(row, byId);
        const destPath = path.join(targetDir, relPath);
        const entryPath = `${relPrefix}/${relPath}`;

        const container = managedDbContainer(row, byId);
        if (container) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            // Blocking lock, like snapshotContainerDataDb: a contended lock must never degrade to a
            // raw read of the live main file, which would drop every commit still sitting in the WAL.
            // Deadlock-safe by the same argument — a close never parks on the container lock (its own
            // snapshot try-locks and skips) and the backup holds no closing slot of its own.
            // False = the container was deleted, or the version pruned, since the tree read above; the
            // entry drops out of the archive rather than costing the home its whole backup.
            const copied = await mount.withPathLock(container.id, () =>
                stageManagedDbCopy(mount, row.id, destPath, 'open-handle-first'),
            );
            if (copied) {
                normalizeArchiveDatabase(destPath);
                entries.push(await captureWrittenFile(destPath, entryPath));
            }
        } else {
            // readKey is freshest-first (pending staged copy, then the stored object). Null means the
            // row has no bytes yet (a touched file whose upload never landed); the archive mirrors
            // that absence rather than inventing an empty object.
            const file = await mount.readKey(storageKeyOf(row, byId, mount.isPathBased));
            if (file) entries.push(await captureFile(file, destPath, entryPath));
        }
        onProgress('mount files', index + 1, fileRows.length);
    }
    return entries;
}
