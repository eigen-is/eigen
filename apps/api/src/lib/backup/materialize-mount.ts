// A home folder's mounts put back from an archive, their trash started over, and the checks of an archive before it
// goes in and of what landed, which a rollback also runs on the data in place. The restores use it, such as
// ./eigen restore, whose stage runs beside a live API. So nothing imported here opens a file on load.

import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { PATHS } from '../config/paths';
import { ApiError } from '../core/errors';
import type { DatabaseConfig, SchemaType } from '../core/managed-database';
import { MOUNT_DB_CONFIG, PENDING_UPLOAD_KIND_VERSION } from '../mount/db-config';
import { buildStorageKey } from '../mount/names';
import { paths, pendingUploads } from '../mount/schema';
import { errnoOf } from '../storage/deadline';
import {
    HOME_DATABASES,
    listManagedDatabases,
    readMountPathRows,
    rowArchivePath,
    storageKeyOf,
} from './archive-layout';
import { requireMountDir, resolveInside } from './paths';

// A restored database and the schema this build expects of it.
export type VersionedDatabase = { filePath: string; config: DatabaseConfig<SchemaType> };

// How many databases checkDatabases opens before it gives the event loop back.
const DATABASES_PER_YIELD = 50;

// Puts one mount's files where the restored mount looks for them. The archive holds them by path, so each backend
// derives its keys again; an `s3` mount stages each file with a pending upload, which the UploadQueue drains with
// its retry. Returns the container databases that stayed on local disk.
export function materializeMount(
    homeDir: string,
    summary: BackupManifest['mounts'][number],
    stamp: string,
): VersionedDatabase[] {
    const metadataPath = requireMaterializable(homeDir, summary);
    const mountDir = requireMountDir(homeDir, summary.id);
    const dataDir = path.join(mountDir, PATHS.DRIVE.DATA_DIR);
    const isPathBased = summary.storageType === 'local';
    const isRemote = summary.storageType === 's3';

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
            // A folder carries no bytes, so an empty one has no archive entry. They are recreated from
            // the table, at the key the mount renames them from, or a later rename of one 404s.
            for (const row of rows) {
                if (row.type === 'file' || row.parentId === null) continue;
                fs.mkdirSync(inData(storageKeyOf(row, byId, true)), { recursive: true });
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
                const archived = rowArchivePath(row, byId);
                const source = inData(archived);
                // A bucket's objects did not move aside with the folder: every row gets a fresh key, even one with
                // no bytes, so no upload lands on an object the `.pre-restore-` copy still names.
                if (isRemote) {
                    row.file = buildStorageKey(`${row.id}-r${stamp}`, row.name);
                    orm.update(paths).set({ file: row.file }).where(eq(paths.id, row.id)).run();
                }
                // A row whose storage object was already missing when the backup ran has no bytes here;
                // the restored home mirrors that absence rather than inventing an empty object.
                if (!fs.existsSync(source)) continue;
                const key = storageKeyOf(row, byId, isPathBased);
                if (isRemote) {
                    const staged = crypto.randomUUID();
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

// Refuses a home folder still in the archive's layout that materializeMount could not put back or this server could
// not open. A per-home restore runs it on the unpacked archive while the home still serves, so a refusal costs nobody
// a page. In that layout every document database of a mount is at its archive path, an s3 mount's included.
export async function checkUnpackedHome(homeDir: string, mounts: BackupManifest['mounts']): Promise<void> {
    const containerDatabases: VersionedDatabase[] = [];
    for (const summary of mounts) {
        const dataDir = path.join(requireMountDir(homeDir, summary.id), PATHS.DRIVE.DATA_DIR);
        const db = openToCheck(requireMaterializable(homeDir, summary));
        try {
            for (const entry of listManagedDatabases(readMountPathRows(db))) {
                containerDatabases.push({
                    filePath: inMountData(dataDir, summary.id, entry.path),
                    config: entry.config,
                });
            }
        } finally {
            db.close();
        }
    }
    await checkRestoredDatabases(
        homeDir,
        mounts.map((summary) => summary.id),
        containerDatabases,
    );
}

// What landed has to be a database this server can still open: SQLite's own verdict on the bytes,
// and the schema stamp against the config that will open them. A database from a newer server passes
// quick_check and is then refused by ManagedDatabase's forward-version guard, which fails the whole
// home on the next load, long after the job said it was done. It opens the files directly, never through a home: the
// folder a restore checks is not the home's folder yet, and a rollback's check runs in another process than the API.
export async function checkRestoredDatabases(
    homeDir: string,
    mountIds: readonly string[],
    containerDatabases: readonly VersionedDatabase[],
): Promise<void> {
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
    await checkDatabases(targets);
}

// The same verdict on any databases, such as the server's own. One that is not there is skipped. A home can hold tens
// of thousands of document databases, and each open blocks the thread. The API runs this for a restore, so it lets
// other requests run between every few databases.
export async function checkDatabases(targets: readonly VersionedDatabase[]): Promise<void> {
    for (const [index, target] of targets.entries()) {
        if (index > 0 && index % DATABASES_PER_YIELD === 0) await new Promise(setImmediate);
        if (!fs.existsSync(target.filePath)) continue;
        const version = schemaVersionOf(target.filePath);
        if (version > target.config.currentVersion) {
            throw new ApiError(
                400,
                `${target.filePath} is at ${target.config.name} schema v${version}, newer than this server ` +
                    `supports (v${target.config.currentVersion}) — restore it on a server at least as new`,
            );
        }
        const db = openToCheck(target.filePath);
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

// Every restore starts the trash of each restored mount over at `now`, in seconds as trashPath writes it. Whoever
// restored gets the whole retention window to look through what came back, and the purge at the home's first load
// deletes nothing whose time ran out since the backup. It also keeps that purge off bucket objects that a folder kept
// aside may still name. A mount with no metadata.db has no trash.
export function redateTrash(homeDir: string, mountIds: readonly string[], now: number): void {
    for (const mountId of mountIds) {
        const metadataPath = path.join(requireMountDir(homeDir, mountId), PATHS.DRIVE.METADATA_DB);
        if (!fs.existsSync(metadataPath)) continue;
        const db = new Database(metadataPath, { readwrite: true, create: false });
        try {
            db.run('UPDATE paths SET trashedAt = ? WHERE trashedAt IS NOT NULL', [now]);
        } finally {
            db.close();
        }
    }
}

// The mounts a home folder holds, by their folders, for a check with no manifest to name them.
export function mountIdsIn(homeDir: string): string[] {
    const mountsDir = path.join(homeDir, PATHS.DRIVE.ROOT);
    if (!fs.existsSync(mountsDir)) return [];
    return fs
        .readdirSync(mountsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
}

// The managed databases a home folder holds, for a restore with no manifest to enumerate them
// from: every mount's paths table, keyed the way that mount's own backend keys its objects. A
// remote mount's are in its bucket, so the path derived for one does not exist and the check skips
// it. That is exactly what materializeMount returns for the same mount.
export function containerDatabasesIn(homeDir: string, mountIds: readonly string[]): VersionedDatabase[] {
    const found: VersionedDatabase[] = [];
    for (const mountId of mountIds) {
        const mountDir = requireMountDir(homeDir, mountId);
        const dataDir = path.join(mountDir, PATHS.DRIVE.DATA_DIR);
        const metadataPath = path.join(mountDir, PATHS.DRIVE.METADATA_DB);
        if (!fs.existsSync(metadataPath)) continue;
        const db = openToCheck(metadataPath);
        try {
            const rows = readMountPathRows(db);
            const byId = new Map(rows.map((row) => [row.id, row]));
            // A folder row carries its own name as `file` on a path-based mount, and nothing on a
            // flat-key one (Mount.createFolder). That tells the two layouts apart with no manifest to
            // ask. A mount with no folders has no containers either.
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

// A move inside one unpacked tree, so on one disk.
export function movePath(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
}

// A whole home from the backups folder into data/: on Docker the two are separate mounts, a rename between them
// fails with EXDEV, and the copy that replaces it must not hold every other user's requests.
export async function movePathAsync(from: string, to: string): Promise<void> {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to).catch(async (error: unknown) => {
        if (errnoOf(error) !== 'EXDEV') throw error;
        // A rename keeps every mtime, and Dovecot dates a Maildir message by its own.
        await fsp.cp(from, to, { recursive: true, preserveTimestamps: true });
        await fsp.rm(from, { recursive: true, force: true });
    });
}

// A database that is there, opened to be read beside a process that may be writing it, such as the live API. It is
// read-write, because a closed WAL database has no -shm and a read-only open of it fails. A writer is waited out as
// long as the API waits for one, so a busy database is not read as damaged.
export function openToCheck(filePath: string): Database {
    const db = new Database(filePath, { readwrite: true, create: false });
    db.run('PRAGMA busy_timeout = 5000;');
    return db;
}

// The metadata.db of a mount the archive promises, refused when materializeMount could not restore from it.
function requireMaterializable(homeDir: string, summary: BackupManifest['mounts'][number]): string {
    const metadataPath = path.join(requireMountDir(homeDir, summary.id), PATHS.DRIVE.METADATA_DB);
    if (!fs.existsSync(metadataPath)) {
        throw new ApiError(400, `The archive promises mount ${summary.id} but carries no metadata.db for it`);
    }
    if (summary.storageType !== 's3') return metadataPath;
    // The pending rows materializeMount writes need the `isDatabase` column: without it every restored file would
    // later be dropped as a corrupt staged copy.
    const metadataVersion = schemaVersionOf(metadataPath);
    if (metadataVersion < PENDING_UPLOAD_KIND_VERSION) {
        throw new ApiError(
            400,
            `Mount ${summary.id} was archived at metadata schema v${metadataVersion}, too old to restore ` +
                `(v${PENDING_UPLOAD_KIND_VERSION} or newer needed)`,
        );
    }
    return metadataPath;
}

// A database with no stamp, or one that does not open, reads as 0, which ManagedDatabase takes as "never migrated".
// The quick_check after it names the failure.
function schemaVersionOf(filePath: string): number {
    let db: Database | null = null;
    try {
        db = openToCheck(filePath);
        const row = db.query<{ version: number }, []>('SELECT version FROM __schema_version WHERE id = 1').get();
        return row?.version ?? 0;
    } catch {
        return 0;
    } finally {
        db?.close();
    }
}

// Verify refuses a paths table that could leave its mount (checkArchivedPathRows). This second guard resolves every
// path a restore derives from one, so nothing here reads or moves a byte outside `data/`.
function inMountData(dataDir: string, mountId: string, relPath: string): string {
    const abs = resolveInside(dataDir, relPath);
    if (!abs) throw new ApiError(400, `Mount ${mountId} names a path that leaves it: ${relPath}`);
    return abs;
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
