import { constants, Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eq } from 'drizzle-orm';
import { ApiError } from '../core';
import { withDocumentDb } from '../mount/document-db';
import { isViableRecoveryTemp } from '../mount/helpers';
import type { Mount } from '../mount/mount';
import { paths } from '../mount/schema';
import { markContainerContentDirty } from '../mount/search-index';
import { isMissingObjectCause, storageGone, writeTempWithHash } from '../storage';
import { getShutdownDrainDeadline } from '../sync';
import { type RetentionPolicy, selectSnapshotsToPrune } from './retention';
import { formatSnapshotTimestamp } from './timestamp';
import { VERSIONS_FOLDER_NAME } from './versions-folder';

// The mechanics half of file versioning: write/replace a container's data.db snapshot on
// its mount. The orchestration half (grab target, pre-restore snapshot, Yjs surgery vs
// chat byte-overwrite) lives next door in restore.ts.

// Snapshots the container's data.db into versions/<iso-ts>.db, then prunes per
// the retention policy. Self-locked on the container: the manual save and a
// restore's pre-restore snapshot call this directly and serialize here — no
// caller has to remember to lock, and nothing holds the lock across another
// snapshot, so there is no deadlock to reason about. An explicit user action
// must never silently skip, hence blocking; the timer/close path instead goes
// through trySnapshotContainerDataDb below.
export async function snapshotContainerDataDb(
    mount: Mount,
    containerId: string,
    policy: RetentionPolicy,
): Promise<DrivePath> {
    return mount.withPathLock(containerId, () => takeSnapshot(mount, containerId, policy, { awaitSlot: true }));
}

// The tick/close (ManagedDatabase onSnapshot) twin: it runs inside a close that holds the doc's
// slot (or a tick that close waits on), and a container-lock holder may be waiting on that slot,
// so it try-locks rather than parks. A skip forgoes at most one version-history entry, never
// bytes (the sync already staged them); a tick-path skip retries next tick because snapshotIfDue
// doesn't advance on 'skipped'.
export async function trySnapshotContainerDataDb(
    mount: Mount,
    containerId: string,
    policy: RetentionPolicy,
): Promise<'taken' | 'skipped'> {
    const taken = await mount.tryWithPathLock(containerId, () => takeSnapshot(mount, containerId, policy));
    return taken === null ? 'skipped' : 'taken';
}

async function takeSnapshot(
    mount: Mount,
    containerId: string,
    policy: RetentionPolicy,
    opts?: { awaitSlot?: boolean },
): Promise<DrivePath> {
    const dataDb = await mount.getChildByName(containerId, 'data.db');
    if (!dataDb) throw new ApiError(404, `data.db not found in container ${containerId}`);

    // Flush the cached db so the copy below reads its pending writes. The blocking path (manual
    // save, pre-restore) waits out an in-flight open or close of it; the tick/close path must not
    // wait, as it runs inside that very close, and mid-close the slot holds no db.
    if (opts?.awaitSlot) {
        await withDocumentDb(mount, dataDb.id, async (slot) => {
            await slot.db?.flush();
        });
    } else {
        await mount.documentDbs.get(dataDb.id)?.db?.flush();
    }

    let versions = await mount.getChildByName(containerId, VERSIONS_FOLDER_NAME);
    if (!versions) {
        const newId = await mount.createFolder(containerId, VERSIONS_FOLDER_NAME);
        const created = await mount.getPath(newId);
        if (!created) throw new ApiError(500, 'Failed to create versions folder');
        versions = created;
    }

    const snapshotName = formatSnapshotTimestamp(new Date());
    // Two snapshots in the same millisecond capture the same instant — reuse
    // the existing one rather than failing on the duplicate name.
    const existing = await mount.getChildByName(versions.id, snapshotName);
    if (existing) return existing;
    // isRemote sources the version from the freshest LOCAL bytes and ENQUEUES its upload,
    // so a close-time snapshot never blocks on the backend — copyPath would instead
    // write the new version to storage synchronously. Local backends are synchronously
    // current, so they keep the direct copyPath.
    const copy = mount.isRemote
        ? await snapshotDataDbToVersionStaged(mount, dataDb, versions.id, snapshotName)
        : await mount.copyPath(dataDb.id, versions.id, snapshotName);

    // Process shutdown skips the prune: a stalled DELETE would eat the drain budget, and the next snapshot prunes.
    if (getShutdownDrainDeadline() !== null) return copy;

    // Prune. Exclude the just-written copy: retention keeps the newest per
    // hour bucket, and excluding the fresh one lets a second snapshot taken
    // within the same hour preserve the first until the hour rolls over.
    const toPrune = selectSnapshotsToPrune(
        (await mount.listFolder(versions.id)).filter((e) => e.id !== copy.id).map((e) => ({ id: e.id, name: e.name })),
        policy,
    );
    for (const item of toPrune) await mount.deletePath(item.id);

    return copy;
}

// isRemote version snapshot: source the bytes from the freshest LOCAL copy of data.db, then
// create the version metadata row and enqueue the upload (so a close-time snapshot never
// blocks on the backend). Caller holds the container lock.
async function snapshotDataDbToVersionStaged(
    mount: Mount,
    dataDb: DrivePath,
    versionsId: string,
    snapshotName: string,
): Promise<DrivePath> {
    const queue = mount.uploadQueue!; // isRemote-only path (snapshotContainerDataDb branch)
    const versionStaging = queue.newStagingPath();
    const staged = await stageManagedDbCopy(mount, dataDb.id, versionStaging, 'staged-first').catch(
        (error: unknown) => {
            // A failed read leaves a half-written copy no pending upload references.
            fs.rmSync(versionStaging, { force: true });
            throw error;
        },
    );
    if (!staged) throw storageGone();
    const versionPathId = await mount.touchFile(versionsId, snapshotName, dataDb.mimeType);
    const versionKey = await mount.getStorageKey(versionPathId);
    const size = fs.statSync(versionStaging).size;
    await mount.db.update(paths).set({ size, updatedAt: new Date() }).where(eq(paths.id, versionPathId));
    await mount.invalidateAncestorsOf(versionPathId);
    queue.enqueueStaged(versionKey, versionStaging, true);
    const created = await mount.getPath(versionPathId);
    if (!created) throw new ApiError(500, 'Failed to create version snapshot');
    return created;
}

// Produce a local copy of a managed container db's current bytes at destPath, freshest source first,
// and say where it came from: only a copy of the stored object shows the store answers.
// Null when there is nothing left to copy: no live handle, no viable crash temp (backup order only),
// nothing staged, and a GET that answers the object missing. The container was deleted or a versions/
// snapshot pruned since the caller read the paths table, or the data.db object is gone, which the
// version snapshot answers with a 410.
// 'staged-first' is the version-snapshot order: its caller flushed the cached db into the pending
// staged copy already, so reusing that copy beats a second VACUUM INTO. 'open-handle-first' is the
// backup order: nothing flushed, so a live handle, or else the crash temp an unclean shutdown left,
// holds the writes made since the last stage; it waits out an in-flight open or close of that handle first.
export async function stageManagedDbCopy(
    mount: Mount,
    pathId: string,
    destPath: string,
    order: 'staged-first' | 'open-handle-first',
): Promise<'local' | 'stored' | null> {
    // 'staged-first' never reads the crash temp: it runs inside a close that holds the slot, mid-teardown of that temp.
    if (order === 'open-handle-first') {
        const staged = await withDocumentDb(mount, pathId, async (slot) => {
            if (slot.db) {
                slot.db.stageCopy(destPath);
                return true;
            }
            if (!mount.needsTempCopy) return false;
            // Inside the slot: an open adopts, rewrites or cleans up this temp, and only the slot orders it against us.
            const row = await mount.getPath(pathId);
            if (!row) return false;
            const temp = mount.getTempPath(pathId);
            if (!isViableRecoveryTemp(temp, row.size ?? 0)) return false;
            // Read-write: a readonly open of a WAL database with no -wal and no -shm fails.
            const db = new Database(temp, { readwrite: true, create: false });
            db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
            try {
                db.run('VACUUM INTO ?', [destPath]);
            } catch (error) {
                throw new Error(`mount ${mount.id}: crash temp of ${pathId} at ${temp} cannot be copied`, {
                    cause: error,
                });
            } finally {
                db.close(true);
            }
            return true;
        });
        if (staged) return 'local';
    }
    // Shared, after the slot: an ancestor's rename on a by-name mount would move the object between its key and the read.
    return mount.withTreeShared(async () => {
        const storageKey = await mount.getStorageKey(pathId);
        // Copy SYNCHRONOUSLY: with no await between pendingStagedCopy's existsSync and the copy, a
        // concurrent enqueue can't unlink it mid-read.
        const pendingStaging = mount.pendingStagedCopy(storageKey);
        if (pendingStaging) {
            fs.copyFileSync(pendingStaging, destPath);
            return 'local';
        }
        // Nothing pending: a live VACUUM INTO if the doc is open, else the storage object — which is
        // current because every upload acked.
        const cached = mount.documentDbs.get(pathId)?.db;
        if (cached) {
            cached.stageCopy(destPath);
            return 'local';
        }
        // A GET, not a HEAD: a HEAD answers a missing bucket as a missing key, and null here is terminal.
        try {
            await writeTempWithHash(destPath, mount.storage.read(storageKey));
            return 'stored';
        } catch (error) {
            if (!isMissingObjectCause(error)) throw error;
            fs.rmSync(destPath, { force: true });
            return null;
        }
    });
}

// Replaces the container's data.db with the file at `sourcePath` — a snapshot the
// caller grabbed into the OS temp dir (downloadToTemp) before the pre-restore
// snapshot could prune it. Self-locked so a concurrent snapshot can't read a
// half-written data.db. Closes the live db with skipFinalSnapshot (we're
// discarding it, and snapshotting here would re-enter this lock), then deletes and
// recreates — a fresh inode, because overwriting the file in place hands SQLite a
// stale vnode (SQLITE_IOERR_VNODE) when the db is reopened.
export async function replaceContainerDataDb(mount: Mount, containerId: string, sourcePath: string): Promise<void> {
    return mount.withPathLock(containerId, async () => {
        // data.db is normally present, but a prior restore that crashed between the
        // delete and recreate below would leave it absent; tolerate that so simply
        // re-running restore self-heals instead of 404-ing forever. The fallback
        // mime matches provisionManagedDbs.
        const dataDb = await mount.getChildByName(containerId, 'data.db');
        const tempId = randomUUID();
        try {
            // Stage + hash the replacement (streamed) before the delete, so a failed source read leaves
            // data.db intact. Inside the try so a write/hash fault still runs cleanupTemp on the partial.
            const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), Bun.file(sourcePath));
            if (dataDb) {
                await mount.closeDatabase(dataDb.id, { skipFinalSnapshot: true });
                await mount.deletePath(dataDb.id);
            }
            const newId = await mount.createFileFromTemp(
                containerId,
                'data.db',
                dataDb?.mimeType ?? 'application/x-sqlite3',
                size,
                hash,
                tempId,
            );
            // createFileFromTemp fires no onSync — mark the container for re-extraction like a synced data.db would.
            await markContainerContentDirty(mount, newId);
        } finally {
            await mount.cleanupTemp(tempId);
        }
    });
}
