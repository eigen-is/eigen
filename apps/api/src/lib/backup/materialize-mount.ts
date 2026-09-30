import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { PATHS } from '../core/constants';
import { ApiError } from '../core/errors';
import type { DatabaseConfig, SchemaType } from '../core/managed-database';
import { MOUNT_DB_CONFIG, PENDING_UPLOAD_KIND_VERSION } from '../mount/db-config';
import { buildStorageKey } from '../mount/names';
import { paths, pendingUploads } from '../mount/schema';
import { errnoOf } from '../storage/deadline';
import { archivePath, HOME_DATABASES, listManagedDatabases, readMountPathRows, storageKeyOf } from './archive-layout';
import { requireMountDir, resolveInside } from './paths';

// A home folder's mounts put back from an archive, and the check of what landed. Shared by the per-home restore
// and ./eigen restore, whose stage runs beside a live API: nothing imported here opens a file on load.

// A restored database and the schema this build expects of it.
export type VersionedDatabase = { filePath: string; config: DatabaseConfig<SchemaType> };

// The backups folder may sit on another disk than the data root, and a rename across the two fails
// with EXDEV — so fall back to a copy.
export function movePath(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.renameSync(from, to);
    } catch (error) {
        if (errnoOf(error) !== 'EXDEV') throw error;
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
    }
}

// What a database says about itself. Absent — no __schema_version table, or a file that cannot be
// opened at all (EACCES, EIO), which is why the open is inside the try — reads as 0, the same as
// ManagedDatabase's own "never migrated" answer, and the quick_check right after it is what turns
// that into a named failure. Read-write, like every open below it: a WAL database nobody is holding
// open has no -shm beside it, and a read-only open of one fails outright.
function schemaVersionOf(filePath: string): number {
    let db: Database | null = null;
    try {
        db = new Database(filePath, { readwrite: true, create: false });
        const row = db.query<{ version: number }, []>('SELECT version FROM __schema_version WHERE id = 1').get();
        return row?.version ?? 0;
    } catch {
        return 0;
    } finally {
        db?.close();
    }
}

// Every path a restore derives from an archive's own paths table is resolved against that mount's
// data folder first. Verify refuses a table that could leave the mount at all
// (checkArchivedPathRows); this is the second lock on the same door, one resolve per path, so no
// route in here can read or move a byte outside `data/`.
function inMountData(dataDir: string, mountId: string, relPath: string): string {
    const abs = resolveInside(dataDir, relPath);
    if (!abs) throw new ApiError(400, `Mount ${mountId} names a path that leaves it: ${relPath}`);
    return abs;
}

// Put one mount's files where the restored mount will look for them. The archive holds every file
// under `data/` by path (what a `local` mount stores natively), so every backend re-derives its own
// keys from the restored tree: a path-based mount its name chain, a `local-key` mount a flat key,
// and an `s3` mount stages the file with a pending upload so the existing UploadQueue drains it to
// the bucket with its normal retry and backoff — the user can work at once, and a flaky bucket makes
// the restore resumable by construction. Returns the container databases that stayed on local disk.
export function materializeMount(
    homeDir: string,
    summary: BackupManifest['mounts'][number],
    stamp: string,
): VersionedDatabase[] {
    // restoreHome refuses such an archive from its manifest (incompleteReason); this is the second
    // lock, where the harm would be: below, an s3 mount's rows get fresh keys and a body the archive
    // does not hold reads as missing at backup, so every file of the mount would be lost.
    if (summary.contents === 'metadata') {
        throw new ApiError(
            400,
            `Mount ${summary.id} holds only its metadata in the archive, not its files, so it cannot be restored`,
        );
    }
    // The id comes out of the archive's manifest. The parser holds it to the class a real mount id
    // uses, and this is the second lock on the same door.
    const mountDir = requireMountDir(homeDir, summary.id);
    const dataDir = path.join(mountDir, PATHS.DRIVE.DATA_DIR);
    const metadataPath = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
    if (!fs.existsSync(metadataPath)) {
        throw new ApiError(400, `The archive promises mount ${summary.id} but carries no metadata.db for it`);
    }
    const isPathBased = summary.storageType === 'local';
    const isRemote = summary.storageType === 's3';
    // Only a remote mount gets pending rows written for it, and those name the column that carries
    // the kind of each staged copy (schema.ts, `isDatabase`). An archive from before that column
    // would take its DEFAULT and every restored plain file would later be dropped as a corrupt
    // staged copy — so refuse it here, and leave a local mount's older archive alone.
    const metadataVersion = schemaVersionOf(metadataPath);
    if (isRemote && metadataVersion < PENDING_UPLOAD_KIND_VERSION) {
        throw new ApiError(
            400,
            `Mount ${summary.id} was archived at metadata schema v${metadataVersion}, too old to restore ` +
                `(v${PENDING_UPLOAD_KIND_VERSION} or newer needed)`,
        );
    }

    const db = new Database(metadataPath);
    try {
        const orm = drizzle(db);
        const rows = readMountPathRows(db);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const managed = listManagedDatabases(rows);
        const inData = (relPath: string): string => inMountData(dataDir, summary.id, relPath);
        // Every pending row names a staged copy on the source server that the archive does not carry.
        orm.delete(pendingUploads).run();

        if (isPathBased) {
            // A folder carries no bytes, so an empty one has no archive entry — recreate them from
            // the table, or a later rename of one 404s.
            for (const row of rows) {
                if (row.type === 'file' || row.parentId === null) continue;
                fs.mkdirSync(inData(archivePath(row, byId)), { recursive: true });
            }
        }
        // The MOUNT's staging folder, where the upload queue keeps a copy until its PUT acks —
        // nothing to do with the job staging folder the archive was unpacked into.
        const mountStagingDir = path.join(mountDir, PATHS.DRIVE.STAGING_DIR);
        if (isRemote) fs.mkdirSync(mountStagingDir, { recursive: true });
        const now = Date.now();
        const managedPaths = new Set(managed.map((entry) => entry.path));
        for (const row of rows) {
            if (row.type !== 'file') continue;
            const archived = archivePath(row, byId);
            const source = inData(archived);
            // A remote mount's objects are the only ones a restore could write over: they are in a
            // bucket, not in the folder that moved aside. So every one of its rows gets a key of its
            // own, and the `.pre-restore-` copy keeps pointing at objects that still hold its bytes.
            // Before the missing-bytes check, not after: a row the archive carries nothing for must
            // not keep the key the copy references, or a late upload would land on an object it owns
            // (a fresh key with nothing behind it reads as absent, which is what that row is). The
            // row is this function's read model, so the new key goes into it and into the table.
            if (isRemote) {
                row.file = buildStorageKey(`${row.id}-r${stamp}`, row.name);
                orm.update(paths).set({ file: row.file }).where(eq(paths.id, row.id)).run();
            }
            // A row whose storage object was already missing when the backup ran has no bytes here;
            // the restored home mirrors that absence rather than inventing an empty object.
            if (!fs.existsSync(source)) continue;
            const key = storageKeyOf(row, byId, isPathBased);
            if (isRemote) {
                const staged = randomUUID();
                movePath(source, path.join(mountStagingDir, staged));
                orm.insert(pendingUploads)
                    .values({
                        storageKey: key,
                        stagingPath: staged,
                        attempt: 0,
                        enqueuedAt: now,
                        nextAttemptAt: now,
                        isDatabase: managedPaths.has(archived),
                    })
                    .run();
                continue;
            }
            // Usually the same file on a path-based mount (`file` is the name), but migration v7
            // renamed the NAME of a deduplicated row and left its `file` alone, so the two differ
            // there — and the mount resolves reads through `file`. Nothing can be overwritten either
            // way: a local mount's bytes moved aside with the folder.
            const target = inData(key);
            if (target !== source) movePath(source, target);
        }
        if (isRemote) {
            // An s3 mount's bytes belong in the bucket, and the queue holds every one of them in
            // staging until the PUT acks; the archive still has them all if that never happens.
            // Keeping the by-path tree as well would double the disk a restored remote mount costs.
            fs.rmSync(dataDir, { recursive: true, force: true });
            return [];
        }
        // What is left under data/ after a local-key move is the archive's by-path folders, which
        // that backend has no use for. A path-based mount keeps them: they are its layout.
        if (!isPathBased) pruneEmptyDirs(dataDir);
        return managed.map((entry) => ({
            filePath: inData(storageKeyOf(entry.row, byId, isPathBased)),
            config: entry.config,
        }));
    } finally {
        db.close();
    }
}

// Depth-first, directories only: a leftover file means the tree and the paths table disagree, and
// deleting it would be the restore losing bytes.
function pruneEmptyDirs(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = path.join(dir, entry.name);
        pruneEmptyDirs(child);
        if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
    }
}

// What landed has to be a database this server can still open: SQLite's own verdict on the bytes,
// and the schema stamp against the config that will open them. A database from a NEWER server passes
// quick_check and is then refused by ManagedDatabase's forward-version guard — which fails the whole
// home on the next load, long after the job said it was done. The home is evicted and the restoring
// mark is still set, so this is the one place a live home's databases are opened directly.
export function checkRestoredDatabases(
    homeDir: string,
    mountIds: string[],
    containerDatabases: VersionedDatabase[],
): void {
    const targets: VersionedDatabase[] = HOME_DATABASES.map(([config, relPath]) => ({
        filePath: path.join(homeDir, relPath),
        config,
    }));
    for (const mountId of mountIds) {
        const mountDir = requireMountDir(homeDir, mountId);
        targets.push({ filePath: path.join(mountDir, PATHS.DRIVE.METADATA_DB), config: MOUNT_DB_CONFIG });
    }
    // An s3 mount's container databases are staged copies on their way to the bucket, not files at a
    // knowable path; verify read every one of them in the folder this restore unpacked minutes ago.
    targets.push(...containerDatabases);

    for (const target of targets) {
        if (!fs.existsSync(target.filePath)) continue;
        const version = schemaVersionOf(target.filePath);
        if (version > target.config.currentVersion) {
            throw new ApiError(
                400,
                `${target.filePath} is at ${target.config.name} schema v${version}, newer than this server ` +
                    `supports (v${target.config.currentVersion}) — restore it on a server at least as new`,
            );
        }
        const db = new Database(target.filePath, { readwrite: true, create: false });
        try {
            const row = db.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
            if (row?.quick_check !== 'ok') {
                throw new ApiError(
                    500,
                    `${target.filePath} did not survive the restore: ${row?.quick_check ?? 'no answer'}`,
                );
            }
        } finally {
            db.close();
        }
    }
}

// The managed databases a home folder holds, for a restore with no manifest to enumerate them
// from: every mount's paths table, keyed the way that mount's own backend keys its objects. A
// remote mount's are in its bucket, so the path derived for one does not exist and the check skips
// it — exactly what materializeMount returns for the same mount.
export function containerDatabasesIn(homeDir: string, mountIds: string[]): VersionedDatabase[] {
    const found: VersionedDatabase[] = [];
    for (const mountId of mountIds) {
        const mountDir = requireMountDir(homeDir, mountId);
        const dataDir = path.join(mountDir, PATHS.DRIVE.DATA_DIR);
        const metadataPath = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
        if (!fs.existsSync(metadataPath)) continue;
        const db = new Database(metadataPath, { readwrite: true, create: false });
        try {
            const rows = readMountPathRows(db);
            const byId = new Map(rows.map((row) => [row.id, row]));
            // A folder row carries its own name as `file` on a path-based mount and nothing at all on
            // a flat-key one (Mount.buildFileValue) — which is what tells the two layouts apart with
            // no manifest to ask. A mount with no folders has no containers either.
            const isPathBased = rows.some((row) => row.type !== 'file' && row.parentId !== null && row.file !== '');
            for (const entry of listManagedDatabases(rows)) {
                found.push({
                    filePath: inMountData(dataDir, mountId, storageKeyOf(entry.row, byId, isPathBased)),
                    config: entry.config,
                });
            }
        } finally {
            db.close();
        }
    }
    return found;
}
