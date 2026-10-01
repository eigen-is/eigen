import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry } from '@workspace/lib/types/backup';
import { eq } from 'drizzle-orm';
import { ApiError } from '../core';
import { withDocumentDb } from '../mount/document-db';
import type { Mount } from '../mount/mount';
import { paths } from '../mount/schema';
import { errnoOf, isMissingObjectCause } from '../storage';
import { stageManagedDbCopy } from '../versioning/snapshot';
import { archivePath, MOUNT_PATH_COLUMNS, managedDbContainer, storageKeyOf } from './archive-layout';
import { captureFile, captureUnlessGone, captureWrittenFile } from './capture';
import type { SnapshotProgress } from './snapshot-home';

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
    } catch (error) {
        console.warn(`[backup] could not reset the journal mode of ${destPath}:`, error);
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

// A storage failure fails the whole backup — an archive silently missing a mount's objects is worse
// than no archive. A failed storage call is a 503 carrying the provider's error or the local errno as
// its cause (a timeout carries none), and Bun's S3Error hides the actionable part in `code` behind
// "an unexpected error has occurred". So a local errno is rethrown as itself, a 503 or a coded error
// as one line naming the code and the object, anything else untouched.
function rethrowStorageFailure(mountId: string, storageKey: string, error: unknown): never {
    const unavailable = error instanceof ApiError && error.status === 503;
    const failure = unavailable ? error.cause : error;
    const code = errnoOf(failure);
    if (code && LOCAL_FAILURE_CODE.test(code)) throw failure;
    if (!code && !unavailable) throw error;
    throw new Error(`mount ${mountId}: storage unreachable${code ? ` (${code})` : ''} reading ${storageKey}`);
}

// False once the row was deleted, or moved to another key, since the tree read.
async function isStillAt(mount: Mount, pathId: string, storageKey: string): Promise<boolean> {
    return Boolean(await mount.getPath(pathId)) && (await mount.getStorageKey(pathId)) === storageKey;
}

// One mount's data tree in an archive: the entries written, how many of them are Eigen's own
// databases (a user's `notes.db` upload is a file), and the ids the thumbnails are keyed by.
type MountSnapshot = { entries: BackupEntry[]; databases: number; pathIds: Set<string> };

// Copy every file the mount's paths table knows about into `targetDir`. Walking the table rather
// than the filesystem is what keeps `tmp/` and `staging/` out and `.trash/` + `versions/` in, on
// every backend; `thumbs/` is copied separately (snapshotMountThumbs), keyed by the ids returned
// here.
export async function snapshotMountData(
    mount: Mount,
    targetDir: string,
    relPrefix: string,
    onProgress?: SnapshotProgress,
): Promise<MountSnapshot> {
    const rows = await mount.db
        .select({ ...MOUNT_PATH_COLUMNS, size: paths.size })
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
        // A row with bytes on record and none anywhere is a lost object, unless the row went since the tree read.
        const lostObject = () =>
            new Error(`mount ${mount.id}: ${relPath} has ${row.size} bytes on record but no object at ${storageKey}`);
        if (container) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            // Blocking lock, like snapshotContainerDataDb: a contended lock must never degrade to a
            // raw read of the live main file, which would drop every commit still sitting in the WAL.
            // Deadlock-safe: a close never parks on the container lock (its own snapshot try-locks and
            // skips), and the backup is never inside a close of this doc when it waits on its slot.
            // False = no bytes anywhere: skipped when the container was deleted, or the version pruned,
            // since the tree read; a live row with bytes on record fails the backup.
            const copied = await mount
                .withPathLock(container.id, () => stageManagedDbCopy(mount, row.id, destPath, 'open-handle-first'))
                .catch((error: unknown) => rethrowStorageFailure(mount.id, storageKey, error));
            if (copied) {
                normalizeArchiveDatabase(destPath);
                entries.push(await captureWrittenFile(destPath, entryPath));
                databases++;
            } else if (row.size && (await isStillAt(mount, row.id, storageKey))) {
                throw lostObject();
            }
        } else {
            // readKey is freshest-first (pending staged copy, then the stored object). Null for a
            // row with no bytes on record (a touched file) mirrors that absence; null for a row with
            // a size is a lost object. A delete landing between readKey's HEAD and the GET fails the
            // read with NoSuchKey/ENOENT. Either drops out of the archive when the row was deleted or
            // moved since the tree read. A disk that fills up in the archive folder keeps its own
            // errno (LOCAL_FAILURE_CODE): it is not the bucket being unreachable.
            const file = await mount
                .readKey(storageKey)
                .catch((error: unknown) => rethrowStorageFailure(mount.id, storageKey, error));
            if (file) {
                const entry = await captureFile(file, destPath, entryPath).catch(async (error: unknown) => {
                    if (!isMissingObjectCause(error) || (await isStillAt(mount, row.id, storageKey))) {
                        rethrowStorageFailure(mount.id, storageKey, error);
                    }
                    fs.rmSync(destPath, { force: true });
                    return null;
                });
                if (entry) entries.push(entry);
            } else if (row.size && (await isStillAt(mount, row.id, storageKey))) {
                throw lostObject();
            }
        }
        onProgress?.('mount files', index + 1, fileRows.length);
    }
    return { entries, databases, pathIds: new Set(fileRows.map((row) => row.id)) };
}

// A metadata-only capture of an s3 mount reads no object, so an open document's newest commits reach
// the archive only through staging/: flushing stages them there with a pending row, which the
// metadata.db staged after this names. comments.db included, which Mount.flushContainerDb skips.
export async function flushOpenDocumentDbs(mount: Mount): Promise<void> {
    for (const pathId of [...mount.documentDbs.keys()]) {
        await withDocumentDb(mount, pathId, async (slot) => {
            await slot.db?.flush();
        });
    }
}

// The rest of a metadata-only capture: staging/ as it stands, the bytes the bucket does not have yet,
// under the names the pending rows of metadata.db give them. Nothing counts as a database: a staged
// copy is a payload for the upload queue, not one this server opens. The ids are the file rows',
// which the thumbnails are keyed by.
export async function snapshotMountStaging(mount: Mount, targetDir: string, relPrefix: string): Promise<MountSnapshot> {
    const entries: BackupEntry[] = [];
    if (fs.existsSync(mount.stagingDir)) {
        for (const entry of fs.readdirSync(mount.stagingDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            // A staged copy goes once its PUT acks (its bytes are in the bucket) or a newer copy
            // supersedes it (UploadQueue.enqueueStaged), so one can vanish mid-copy. It is left out:
            // the archived pending row then names a missing file, which reconcile drops, and a
            // restore of this level takes the bucket as it is.
            const source = Bun.file(path.join(mount.stagingDir, entry.name));
            const captured = await captureUnlessGone(
                source,
                path.join(targetDir, entry.name),
                `${relPrefix}/${entry.name}`,
            );
            if (captured) entries.push(captured);
        }
    }
    const rows = await mount.db.select({ id: paths.id }).from(paths).where(eq(paths.type, 'file')).all();
    return { entries, databases: 0, pathIds: new Set(rows.map((row) => row.id)) };
}

// Thumbnails are not derived data: they are generated once, when a file is uploaded, and never
// regenerated — the drive route answers 404 for a file whose thumbnail is gone — so a restore
// without them loses every thumbnail the home ever had. They are keyed by path id, which a restore
// preserves. A thumbnail whose row is gone is an orphan no mount would ever serve and stays out.
export async function snapshotMountThumbs(
    thumbsDir: string,
    targetDir: string,
    relPrefix: string,
    pathIds: ReadonlySet<string>,
): Promise<BackupEntry[]> {
    if (!fs.existsSync(thumbsDir)) return [];
    const entries: BackupEntry[] = [];
    for (const entry of fs.readdirSync(thumbsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !pathIds.has(path.parse(entry.name).name)) continue;
        const source = Bun.file(path.join(thumbsDir, entry.name));
        // Deleting a file for good deletes its thumbnail (Mount.deletePath), so one can go mid-copy.
        const captured = await captureUnlessGone(
            source,
            path.join(targetDir, entry.name),
            `${relPrefix}/${entry.name}`,
        );
        if (captured) entries.push(captured);
    }
    return entries;
}
