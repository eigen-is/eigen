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
import { archivePath, managedDbContainer, readMountPathRows } from './archive-layout';
import { captureFile, captureUnlessGone, captureWrittenFile } from './capture';
import type { SnapshotProgress } from './snapshot-home';

// A WAL-mode database does not open without the `-wal` beside it, which an archive leaves out, so the copy's
// journal mode is rewritten. A failure keeps the copied bytes for verify's quick_check to flag.
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

// The codes of a failure on this machine, which "storage unreachable" would misname. One by one, not `E[A-Z]+`: a
// bucket that refuses the connection surfaces as ECONNREFUSED, and that is the storage being unreachable.
const LOCAL_FAILURE_CODE = /^(SQLITE_[A-Z]+|ENOSPC|EACCES|EDQUOT|EROFS|EIO|ENOENT)$/;

// A storage failure fails the whole backup: an archive missing a mount's objects is worse than none. Bun's S3Error
// hides the actionable part in `code`, so a 503 or a coded error becomes one line naming the code and the object.
function rethrowStorageFailure(mountId: string, storageKey: string, error: unknown): never {
    const unavailable = error instanceof ApiError && error.status === 503;
    const failure = unavailable ? error.cause : error;
    const code = errnoOf(failure);
    if (code && LOCAL_FAILURE_CODE.test(code)) throw failure;
    if (!code && !unavailable) throw error;
    throw new Error(`mount ${mountId}: storage unreachable${code ? ` (${code})` : ''} reading ${storageKey}`);
}

function readArchivedRows(metadataPath: string) {
    const db = new Database(metadataPath, { readonly: true });
    try {
        return readMountPathRows(db);
    } finally {
        db.close();
    }
}

// One mount's data tree in an archive: the entries written, how many of them are Eigen's own
// databases (a user's `notes.db` upload is a file), and the ids the thumbnails are keyed by.
type MountSnapshot = { entries: BackupEntry[]; databases: number; pathIds: Set<string> };

// Copy every file the archived `metadata.db` copy knows about into `targetDir`, at the path its row gives, from
// wherever the live mount keeps it now: a rename, move or trash since the copy changes the key, not the archive path.
// Walking the table rather than the filesystem is what keeps `tmp/` and `staging/` out and `.trash/` + `versions/` in,
// on every backend; `thumbs/` is copied separately (snapshotMountThumbs), keyed by the ids returned here.
export async function snapshotMountData(
    mount: Mount,
    metadataPath: string,
    targetDir: string,
    relPrefix: string,
    onProgress?: SnapshotProgress,
): Promise<MountSnapshot> {
    const rows = readArchivedRows(metadataPath);
    const byId = new Map(rows.map((row) => [row.id, row]));

    const fileRows = rows.filter((row) => row.type === 'file');
    const entries: BackupEntry[] = [];
    // The rows whose bytes are in the archive.
    const held = new Set<string>();
    let databases = 0;
    for (const [index, row] of fileRows.entries()) {
        const relPath = archivePath(row, byId);
        const destPath = path.join(targetDir, relPath);
        const entryPath = `${relPrefix}/${relPath}`;
        const lostObject = (size: number, storageKey: string) =>
            new Error(`mount ${mount.id}: ${relPath} has ${size} bytes on record but no object at ${storageKey}`);
        // Deleted for good since the copy: there are no bytes to take, and its row leaves the archive after the walk.
        const isGone = async () => !(await mount.getPath(row.id));

        const container = managedDbContainer(row, byId);
        if (container) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            // A blocking lock: a raw read of the live main file would drop every commit still in the WAL. False is
            // no bytes anywhere. A gone row is never read: on a by-name mount its key resolves to the data/ folder.
            const copied = await mount
                .withPathLock(
                    container.id,
                    async () => !(await isGone()) && stageManagedDbCopy(mount, row.id, destPath, 'open-handle-first'),
                )
                .catch(async (error: unknown) => {
                    // Empty trash takes no path lock, so a row can still go between the check and the read.
                    if (!(await isGone())) rethrowStorageFailure(mount.id, await mount.getStorageKey(row.id), error);
                    fs.rmSync(destPath, { force: true });
                    return false;
                });
            if (copied) {
                normalizeArchiveDatabase(destPath);
                entries.push(await captureWrittenFile(destPath, entryPath));
                held.add(row.id);
                databases++;
            } else {
                const live = await mount.getPath(row.id);
                if (live?.size) throw lostObject(live.size, await mount.getStorageKey(row.id));
            }
        } else {
            // Shared, as the mount's own key-derived reads: no rename moves the bytes between the key and the copy.
            const entry = await mount.withTreeShared(async () => {
                const live = await mount.getPath(row.id);
                if (!live) return null;
                const storageKey = await mount.getStorageKey(row.id);
                const fail = (error: unknown) => rethrowStorageFailure(mount.id, storageKey, error);
                // Freshest first: the pending staged copy, then the stored object. Null for a row with no bytes on
                // record mirrors that absence.
                const file = await mount.readKey(storageKey).catch(fail);
                if (!file) {
                    if (live.size && !(await isGone())) throw lostObject(live.size, storageKey);
                    return null;
                }
                return captureFile(file, destPath, entryPath).catch(async (error: unknown) => {
                    if (!isMissingObjectCause(error) || !(await isGone())) fail(error);
                    fs.rmSync(destPath, { force: true });
                    return null;
                });
            });
            if (entry) {
                entries.push(entry);
                held.add(row.id);
            }
        }
        onProgress?.('mount files', index + 1, fileRows.length);
    }

    // The archive lists no file it holds no bytes for: a row deleted for good since the copy leaves the archived
    // metadata.db, with the topmost folder or container above it that is gone too and holds none of the archive's
    // bytes, and all under it.
    const holding = new Set<string>();
    for (const id of held) {
        for (let up = byId.get(id)?.parentId; up && !holding.has(up); up = byId.get(up)?.parentId) holding.add(up);
    }
    const gone = new Set<string>();
    for (const row of fileRows) {
        if (held.has(row.id) || (await mount.getPath(row.id))) continue;
        let top = row.id;
        let up = row.parentId;
        while (up && byId.get(up)?.parentId && !holding.has(up) && !gone.has(up) && !(await mount.getPath(up))) {
            top = up;
            up = byId.get(up)?.parentId ?? null;
        }
        gone.add(top);
    }
    const removed = new Set<string>();
    if (gone.size > 0) {
        const db = new Database(metadataPath, { readwrite: true, create: false });
        try {
            // As a live delete: its file events and watchers cascade, and the triggers clear its search rows.
            db.run('PRAGMA foreign_keys = ON');
            const remove = db.query<{ id: string }, [string]>(
                `WITH RECURSIVE subtree(id) AS (SELECT ?1 UNION SELECT paths.id FROM paths JOIN subtree ON paths.parentId = subtree.id)
                 DELETE FROM paths WHERE id IN subtree RETURNING id`,
            );
            db.transaction(() => {
                for (const id of gone) for (const row of remove.all(id)) removed.add(row.id);
            })();
        } finally {
            db.close();
        }
    }
    return {
        entries,
        databases,
        pathIds: new Set(fileRows.filter((row) => !removed.has(row.id)).map((row) => row.id)),
    };
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
