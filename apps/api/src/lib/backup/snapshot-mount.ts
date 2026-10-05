import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupEntry } from '@workspace/lib/types/backup';
import { ApiError } from '../core';
import { withDocumentDb } from '../mount/document-db';
import type { Mount } from '../mount/mount';
import { paths } from '../mount/schema';
import { errnoOf, eventLoopTurn, isMissingObjectCause } from '../storage';
import { stageManagedDbCopy } from '../versioning/snapshot';
import { archivePath, managedDbContainer, readMountPathRows, unreachableRows } from './archive-layout';
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
// databases (a user's `notes.db` upload is a file), the ids the thumbnails are keyed by, and what it lacks.
type MountSnapshot = { entries: BackupEntry[]; databases: number; pathIds: Set<string>; warning?: string };

// A handful of names tells the admin what is missing; the log names them all.
const WARNING_NAMES = 5;

function warningOf(mountId: string, what: string, names: string[]): string {
    const more = names.length > WARNING_NAMES ? ` and ${names.length - WARNING_NAMES} more` : '';
    return `mount ${mountId}: ${what}: ${names.slice(0, WARNING_NAMES).join(', ')}${more}`;
}

// A salvaged or hand-edited table can hold rows whose parent chain ends at a missing row or in a cycle, and a hand edit
// or an older name rule rows whose name no path can hold. No path is theirs, so the archive's copy drops them before
// anything reads it, as a live delete would, and the backup goes on with a warning per kind. A table whose root row is
// gone holds nothing that can be placed. The live table is never touched.
export function pruneUnreachableRows(mountId: string, metadataPath: string): string[] {
    const db = new Database(metadataPath, { readwrite: true, create: false });
    try {
        const rows = readMountPathRows(db);
        const { orphaned, unusable } = unreachableRows(rows);
        const dropped = [...orphaned, ...unusable].map((row) => row.id);
        if (dropped.length === 0) return [];
        if (dropped.length === rows.length) throw new Error(`mount ${mountId}: the table has no root row`);
        db.run('PRAGMA foreign_keys = ON');
        db.run('DELETE FROM paths WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(dropped)]);
        // A dropped folder takes its contents with it through the foreign key, and no list names them. Counted, not
        // read from the delete's changes: the triggers that clear search rows count there too.
        const left = db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM paths').get()?.count ?? 0;
        const inside = rows.length - dropped.length - left;
        console.warn(`[backup] mount ${mountId}: left out rows ${dropped.join(', ')} and ${inside} more inside them`);
        const warnings: string[] = [];
        if (orphaned.length > 0) {
            const names = orphaned.map((row) => row.name);
            warnings.push(warningOf(mountId, "entries that do not reach the drive's root, left out", names));
        }
        if (unusable.length > 0) {
            const names = unusable.map((row) => row.name);
            const more = inside > 0 ? ` with ${inside} more inside them` : '';
            warnings.push(warningOf(mountId, `entries with a name no path can hold, left out${more}`, names));
        }
        return warnings;
    } finally {
        db.close();
    }
}

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
    // The rows whose bytes are in the archive, how many of them were read from storage rather than a local copy,
    // and the rows with bytes on record that storage has no object for.
    const held = new Set<string>();
    let stored = 0;
    const lost: string[] = [];
    let databases = 0;
    // The plain files taken, with the date of the live row, which the path lock kept in step with the bytes read.
    const files: { id: string; captured: BackupEntry; updatedAt: Date }[] = [];
    for (const [index, row] of fileRows.entries()) {
        await eventLoopTurn();
        const relPath = archivePath(row, byId);
        const destPath = path.join(targetDir, relPath);
        const entryPath = `${relPrefix}/${relPath}`;
        // The row stays, with no bytes, which a restore mirrors.
        const recordLost = (size: number, storageKey: string) => {
            lost.push(relPath);
            console.warn(
                `[backup] mount ${mount.id}: ${relPath} has ${size} bytes on record but no object at ${storageKey}`,
            );
        };
        // Deleted for good since the copy: there are no bytes to take, and its row leaves the archive after the walk.
        const isGone = async () => !(await mount.getPath(row.id));

        const container = managedDbContainer(row, byId);
        if (container) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            // A blocking lock: a raw read of the live main file would drop every commit still in the WAL. False is
            // no bytes anywhere. A gone row is never read: on a by-name mount its key resolves to the data/ folder.
            const source = await mount
                .withPathLock(container.id, async () =>
                    (await isGone()) ? null : stageManagedDbCopy(mount, row.id, destPath, 'open-handle-first'),
                )
                .catch(async (error: unknown) => {
                    // Empty trash takes no path lock, so a row can still go between the check and the read.
                    if (!(await isGone())) rethrowStorageFailure(mount.id, await mount.getStorageKey(row.id), error);
                    fs.rmSync(destPath, { force: true });
                    return null;
                });
            if (source) {
                normalizeArchiveDatabase(destPath);
                entries.push(await captureWrittenFile(destPath, entryPath));
                held.add(row.id);
                if (source === 'stored') stored++;
                databases++;
            } else {
                const live = await mount.getPath(row.id);
                if (live?.size) recordLost(live.size, await mount.getStorageKey(row.id));
            }
        } else {
            // The path lock for the whole copy: an overwrite rewrites the file in place, so it and the copy wait for
            // each other. The shared tree lock only until the file is open, so no rename moves the bytes between the
            // key and the open, and a rename after it waits for no copy: captureFile opens before its first await
            // (capture-race.test.ts moves the bytes as the lock releases).
            const entry = await mount.withPathLock(row.id, async () => {
                const opened = await mount.withTreeShared(async () => {
                    const live = await mount.getPath(row.id);
                    if (!live) return null;
                    const storageKey = await mount.getStorageKey(row.id);
                    const fail = (error: unknown) => rethrowStorageFailure(mount.id, storageKey, error);
                    // Freshest first: the pending staged copy, then the stored object. Null for a row with no bytes on
                    // record mirrors that absence. readKey asks pendingStagedCopy before its first await, so both
                    // calls see the same staging.
                    const fromStorage = !mount.pendingStagedCopy(storageKey);
                    const file = await mount.readKey(storageKey).catch(fail);
                    if (!file) {
                        if (live.size && !(await isGone())) recordLost(live.size, storageKey);
                        return null;
                    }
                    const copy = captureFile(file, destPath, entryPath, true).catch(async (error: unknown) => {
                        if (!isMissingObjectCause(error) || !(await isGone())) fail(error);
                        fs.rmSync(destPath, { force: true });
                        return null;
                    });
                    return { copy, fromStorage, updatedAt: live.updatedAt };
                });
                if (!opened) return null;
                const captured = await opened.copy;
                if (captured && opened.fromStorage) stored++;
                return captured && { captured, updatedAt: opened.updatedAt };
            });
            if (entry) {
                entries.push(entry.captured);
                held.add(row.id);
                files.push({ id: row.id, ...entry });
            }
        }
        onProgress?.('mount files', index + 1, fileRows.length);
    }
    // A store with holes is archived with them; one that answered no read at all is an outage that reads as missing
    // objects: an unmounted disk or an unreadable folder answers exists() with false, a wrong bucket answers a HEAD 404.
    // A copy from an open handle, a crash temp or staging/ never asked the store, so it does not count.
    if (lost.length > 0 && stored === 0) {
        throw new Error(`mount ${mount.id}: storage unreachable, no file with bytes on record was read from it`);
    }

    // The archive lists no file it holds no bytes for: a row deleted for good since the copy leaves the archived
    // metadata.db, with the topmost folder or container above it that is gone too and holds no live row and none of
    // the archive's bytes, and all under it.
    const live = new Set((await mount.db.select({ id: paths.id }).from(paths).all()).map((row) => row.id));
    const kept = new Set<string>();
    for (const row of rows) {
        if (!live.has(row.id) && !held.has(row.id)) continue;
        for (let id: string | null = row.id; id && !kept.has(id); id = byId.get(id)?.parentId ?? null) kept.add(id);
    }
    const gone = new Set<string>();
    for (const row of fileRows) {
        if (kept.has(row.id)) continue;
        let top = row.id;
        for (let up = row.parentId; up && byId.get(up)?.parentId && !kept.has(up); up = byId.get(up)?.parentId ?? null)
            top = up;
        gone.add(top);
    }
    const stale = new Set<string>();
    const staleAbove = (id: string) => {
        for (let up = byId.get(id)?.parentId; up && !stale.has(up); up = byId.get(up)?.parentId) stale.add(up);
    };
    const db = new Database(metadataPath, { readwrite: true, create: false });
    try {
        db.run('PRAGMA foreign_keys = ON');
        db.transaction(() => {
            // A file overwritten between the database copy and its read: its row takes the size, hash and date of
            // the bytes the archive holds, as the overwrite gave the live one, and its search text is rebuilt from them.
            // A row with no hash on record differs only by its size.
            const rewrite = db.prepare<unknown, [number, string, number, string]>(
                'UPDATE paths SET size = ?1, hash = ?2, updatedAt = ?3, contentDirty = 1 WHERE id = ?4 AND (size IS NOT ?1 OR (hash IS NOT NULL AND hash IS NOT ?2))',
            );
            for (const { id, captured, updatedAt } of files) {
                const seconds = Math.floor(updatedAt.getTime() / 1000);
                if (rewrite.run(captured.bytes, captured.sha256, seconds, id).changes > 0) staleAbove(id);
            }
            // As a live delete: its children, file events and watchers cascade, the triggers clear its search rows,
            // and every folder above it has its cached size NULLed (stale).
            for (const top of gone) staleAbove(top);
            db.run('UPDATE paths SET size = NULL WHERE id IN (SELECT value FROM json_each(?))', [
                JSON.stringify([...stale]),
            ]);
            db.run('DELETE FROM paths WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify([...gone])]);
        })();
    } finally {
        db.close();
    }
    const left = gone.size > 0 ? readArchivedRows(metadataPath) : rows;
    return {
        entries,
        databases,
        pathIds: new Set(left.filter((row) => row.type === 'file').map((row) => row.id)),
        warning:
            lost.length > 0
                ? warningOf(mount.id, 'files with no object in storage, archived without their bytes', lost)
                : undefined,
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
// copy is a payload for the upload queue, not one this server opens. The ids are the file rows' of
// the archived metadata.db, which the thumbnails are keyed by.
export async function snapshotMountStaging(
    mount: Mount,
    metadataPath: string,
    targetDir: string,
    relPrefix: string,
): Promise<MountSnapshot> {
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
    const rows = readArchivedRows(metadataPath).filter((row) => row.type === 'file');
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
