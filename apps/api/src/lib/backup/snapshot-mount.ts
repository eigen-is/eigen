import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry } from '@workspace/lib/types/backup';
import { type DrivePathType, isCollabType, isDocumentType } from '@workspace/lib/types/drive';
import { COMMENT_INDEX_DB_CONFIG } from '../chat/comment-db-config';
import { CHAT_ROOM_DB_CONFIG } from '../chat/db-config';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import type { DatabaseConfig, SchemaType } from '../core';
import { buildStorageKey, isUsableName } from '../mount/helpers';
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

// What a flat-key backend (`local-key`, `s3`) stores a row's object under: `file`, falling back to
// the id for a row written before that column carried a value — Mount.getStorageKey's own rule.
// A path-based mount needs the whole ancestor chain instead (storageKeyOf).
export function flatStorageKey(row: Pick<MountPathRow, 'id' | 'file'>): string {
    return row.file || row.id;
}

// Mirrors Mount.resolveStoragePath / getStorageKey, resolved from the tree we already hold rather
// than one recursive-CTE query per file. Exported for restore, which puts every file back at the
// key the restored mount will look for it under — one spelling of the rule for both directions.
export function storageKeyOf(row: MountPathRow, byId: Map<string, MountPathRow>, isPathBased: boolean): string {
    if (!isPathBased) return flatStorageKey(row);
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

// A live paths table can hold none of this: validateName wrote every `name`, and every `file` is a
// name or a `{id}.{ext}` key. An archived one arrived inside a file an admin uploaded, and every
// path a restore builds is a join of those two columns — a `..` in either moved bytes out of the
// mount (a flat-key mount stores under `file`) or an arbitrary server file into it (the archive
// tree IS the name chain). So the archive is refused whole, before a restore reads a row of it.
export function checkArchivedPathRows(rows: MountPathRow[]): string[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const failures: string[] = [];
    for (const row of rows) {
        if (!isUsableName(row.name)) failures.push(`path row ${row.id} has an unusable name "${row.name}"`);
        // Empty is how a flat-key mount spells a folder row (Mount.buildFileValue).
        if (row.file !== '' && !isUsableName(row.file)) {
            failures.push(`path row ${row.id} has an unusable file "${row.file}"`);
        }
        if (row.parentId !== null && !byId.has(row.parentId)) {
            failures.push(`path row ${row.id} names a parent (${row.parentId}) the table does not hold`);
            continue;
        }
        // Both path builders walk this chain, and `ancestors` stops on a cycle rather than reporting
        // one: a tree that does not terminate at the root describes no archive.
        const seen = new Set<string>([row.id]);
        for (let current = row.parentId; current !== null; current = byId.get(current)?.parentId ?? null) {
            if (seen.has(current)) {
                failures.push(`path row ${row.id} sits in a parent cycle`);
                break;
            }
            seen.add(current);
        }
    }
    return failures;
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

// The codes a failure on THIS machine carries: SQLite's own from a VACUUM INTO, and the local-disk
// errnos the copy into the archive folder raises. Both already say what went wrong and where, and
// calling either "storage unreachable" would send the admin after the wrong machine. Listed one by
// one rather than as `E[A-Z]+`: a bucket that refuses the connection can surface as a node errno
// (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`), and that IS the storage being unreachable.
const LOCAL_FAILURE_CODE = /^(SQLITE_[A-Z]+|ENOSPC|EACCES|EDQUOT|EROFS|EIO|ENOENT)$/;

// A storage failure must fail the whole backup — an archive silently missing a mount's objects is
// worse than no archive — but Bun's S3Error puts the actionable part in `code` and leaves `message`
// as "an unexpected error has occurred", which is all the job's one-line error would have shown.
// Only that shape is rewritten, and it names the object it was reading; anything else is rethrown
// untouched.
function rethrowStorageFailure(mount: Mount, storageKey: string, error: unknown): never {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (!code || LOCAL_FAILURE_CODE.test(code)) throw error;
    throw new Error(`mount ${mount.id}: storage unreachable (${code}) reading ${storageKey}`);
}

// One mount's data tree in an archive: the entries written, how many of them are Eigen's own
// databases (a user's `notes.db` upload is a file), and the ids the thumbnails are keyed by.
export type MountSnapshot = { entries: BackupEntry[]; databases: number; pathIds: Set<string> };

// Copy every file the mount's paths table knows about into `targetDir`. Walking the table rather
// than the filesystem is what keeps `tmp/` and `staging/` out and `.trash/` + `versions/` in, on
// every backend; `thumbs/` is copied separately (snapshotMountThumbs), keyed by the ids returned
// here.
export async function snapshotMountData(
    mount: Mount,
    targetDir: string,
    relPrefix: string,
    onProgress: SnapshotProgress,
): Promise<MountSnapshot> {
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
    let databases = 0;
    for (const [index, row] of fileRows.entries()) {
        const relPath = archivePath(row, byId);
        const destPath = path.join(targetDir, relPath);
        const entryPath = `${relPrefix}/${relPath}`;
        const storageKey = storageKeyOf(row, byId, mount.isPathBased);

        const container = managedDbContainer(row, byId);
        if (container) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            // Blocking lock, like snapshotContainerDataDb: a contended lock must never degrade to a
            // raw read of the live main file, which would drop every commit still sitting in the WAL.
            // Deadlock-safe by the same argument — a close never parks on the container lock (its own
            // snapshot try-locks and skips) and the backup holds no closing slot of its own.
            // False = the container was deleted, or the version pruned, since the tree read above; the
            // entry drops out of the archive rather than costing the home its whole backup.
            const copied = await mount
                .withPathLock(container.id, () => stageManagedDbCopy(mount, row.id, destPath, 'open-handle-first'))
                .catch((error: unknown) => rethrowStorageFailure(mount, storageKey, error));
            if (copied) {
                normalizeArchiveDatabase(destPath);
                entries.push(await captureWrittenFile(destPath, entryPath));
                databases++;
            }
        } else {
            // readKey is freshest-first (pending staged copy, then the stored object). Null means the
            // row has no bytes yet (a touched file whose upload never landed); the archive mirrors
            // that absence rather than inventing an empty object. Only the read is judged as a
            // storage failure: the copy that follows writes to the archive folder, and a disk that
            // fills up there is not the bucket being unreachable.
            const file = await mount
                .readKey(storageKey)
                .catch((error: unknown) => rethrowStorageFailure(mount, storageKey, error));
            if (file) entries.push(await captureFile(file, destPath, entryPath));
        }
        onProgress('mount files', index + 1, fileRows.length);
    }
    return { entries, databases, pathIds: new Set(fileRows.map((row) => row.id)) };
}

// Thumbnails are not derived data: they are generated once, when a file is uploaded, and never
// regenerated — the drive route answers 404 for a file whose thumbnail is gone — so a restore
// without them loses every thumbnail the home ever had. They are keyed by path id, which a restore
// preserves. A thumbnail whose row is gone is an orphan no mount would ever serve and stays out.
export async function snapshotMountThumbs(
    mount: Mount,
    targetDir: string,
    relPrefix: string,
    pathIds: ReadonlySet<string>,
): Promise<BackupEntry[]> {
    if (!fs.existsSync(mount.thumbsDir)) return [];
    const entries: BackupEntry[] = [];
    for (const entry of fs.readdirSync(mount.thumbsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !pathIds.has(path.parse(entry.name).name)) continue;
        const source = Bun.file(path.join(mount.thumbsDir, entry.name));
        // A thumbnail regenerated (and briefly unlinked) mid-walk is out of the archive either way;
        // losing the whole snapshot over one is not.
        if (await source.exists()) {
            entries.push(await captureFile(source, path.join(targetDir, entry.name), `${relPrefix}/${entry.name}`));
        }
    }
    return entries;
}
