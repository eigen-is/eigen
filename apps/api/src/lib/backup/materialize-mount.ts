import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
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

// The same move for a whole home in the API: on Docker data/ and backups/ are two mounts, so it is always the
// copy, and that copy must not hold every other user's requests.
export async function movePathAsync(from: string, to: string): Promise<void> {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to).catch(async (error: unknown) => {
        if (errnoOf(error) !== 'EXDEV') throw error;
        await fsp.cp(from, to, { recursive: true });
        await fsp.rm(from, { recursive: true, force: true });
    });
}

// A database with no stamp, or one that does not open, reads as 0, ManagedDatabase's "never migrated": the
// quick_check after it names the failure. Read-write: a closed WAL database has no -shm, and a read-only open fails.
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

// Verify refuses a paths table that could leave its mount (checkArchivedPathRows); this second lock resolves every
// path a restore derives from one, so nothing here reads or moves a byte outside `data/`.
function inMountData(dataDir: string, mountId: string, relPath: string): string {
    const abs = resolveInside(dataDir, relPath);
    if (!abs) throw new ApiError(400, `Mount ${mountId} names a path that leaves it: ${relPath}`);
    return abs;
}

// Puts one mount's files where the restored mount looks for them. The archive holds them by path, so each backend
// derives its keys again; an `s3` mount stages each file with a pending upload, which the UploadQueue drains with
// its retry. Returns the container databases that stayed on local disk.
export function materializeMount(
    homeDir: string,
    summary: BackupManifest['mounts'][number],
    stamp: string,
): VersionedDatabase[] {
    // restoreHome refuses such an archive from its manifest; here the harm would be: an s3 mount's rows get fresh
    // keys below, and every file would read as missing.
    if (summary.contents === 'metadata') {
        throw new ApiError(
            400,
            `Mount ${summary.id} holds only its metadata in the archive, not its files, so it cannot be restored`,
        );
    }
    const mountDir = requireMountDir(homeDir, summary.id);
    const dataDir = path.join(mountDir, PATHS.DRIVE.DATA_DIR);
    const metadataPath = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
    if (!fs.existsSync(metadataPath)) {
        throw new ApiError(400, `The archive promises mount ${summary.id} but carries no metadata.db for it`);
    }
    const isPathBased = summary.storageType === 'local';
    const isRemote = summary.storageType === 's3';
    // The pending rows written below need the `isDatabase` column: without it every restored file would later be
    // dropped as a corrupt staged copy.
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
        // The mount's own staging folder, where the upload queue keeps a copy until its PUT acks.
        const mountStagingDir = path.join(mountDir, PATHS.DRIVE.STAGING_DIR);
        if (isRemote) fs.mkdirSync(mountStagingDir, { recursive: true });
        const now = Date.now();
        const managedPaths = new Set(managed.map((entry) => entry.path));
        // One transaction: a VACUUM INTO copy journals and fsyncs every statement on its own, and this is two per file.
        db.transaction(() => {
            for (const row of rows) {
                if (row.type !== 'file') continue;
                const archived = archivePath(row, byId);
                const source = inData(archived);
                // A bucket's objects did not move aside with the folder, so every row gets a fresh key and the
                // `.pre-restore-` copy keeps its objects; a row with no bytes too, or a late upload lands on one.
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
                // On a path-based mount the key is the archive path unless migration v7 renamed a deduplicated
                // row's name and left its `file`, which reads go by.
                const target = inData(key);
                if (target !== source) movePath(source, target);
            }
        })();
        if (isRemote) {
            // Every byte is in staging until its PUT acks; the by-path tree as well would double the disk.
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
