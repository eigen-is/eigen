// Takes a version of a document: a copy of its database saved in the document's versions folder, after which old
// versions are removed by the retention rules. A save by the user waits for its turn, and the periodic save skips
// when the document is busy. It can also replace the live database with a copy, which is what a restore uses. The
// restore code decides which version to bring back.

import { constants, Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eq } from 'drizzle-orm';
import { ApiError, storageGone } from '../core';
import { CONTAINER_DATA_DB } from '../mount/container-dbs';
import { closeInSlot, withDocumentDb } from '../mount/document-db';
import { isViableRecoveryTemp } from '../mount/helpers';
import type { Mount } from '../mount/mount';
import { paths } from '../mount/schema';
import { markContainerContentDirty } from '../mount/search-index';
import { getShutdownDrainDeadline } from '../mount/upload-limits';
import type { UploadQueue } from '../mount/upload-queue';
import { hashFile, isMissingObjectCause, writeTempWithHash } from '../storage';
import type { RetentionPolicy } from './retention';
import { selectSnapshotsToPrune } from './retention';
import { formatSnapshotTimestamp } from './timestamp';
import { VERSIONS_FOLDER_NAME } from './versions-folder';

// Which copy of a managed database a snapshot reads first: a tick or a close reuses what its sync just staged, and
// everyone else, with nothing staged for them, takes the open database or the crash temp.
type CopyOrder = 'staged-first' | 'open-handle-first';

// Copies the container's data.db into its versions folder, then prunes by the retention policy. A save the user
// asked for must never be skipped, so it waits for the container lock.
export async function snapshotContainerDataDb(
    mount: Mount,
    containerId: string,
    policy: RetentionPolicy,
): Promise<DrivePath> {
    return mount.withPathLock(containerId, async () => {
        // Brings data.db's stored object, row and search index up to this version now, not at the next tick.
        await mount.flushContainerDb(containerId);
        return takeSnapshot(mount, containerId, policy, 'open-handle-first');
    });
}

// ManagedDatabase's onSnapshot, inside a close that holds the slot or a tick that a close or a flush waits for. A
// holder of the container lock may wait for that slot, so this only tries the lock.
export async function trySnapshotContainerDataDb(
    mount: Mount,
    containerId: string,
    policy: RetentionPolicy,
): Promise<'taken' | 'skipped'> {
    const taken = await mount.tryWithPathLock(containerId, () =>
        takeSnapshot(mount, containerId, policy, 'staged-first'),
    );
    return taken === null ? 'skipped' : 'taken';
}

async function takeSnapshot(
    mount: Mount,
    containerId: string,
    policy: RetentionPolicy,
    order: CopyOrder,
): Promise<DrivePath> {
    const dataDb = await mount.getChildByName(containerId, CONTAINER_DATA_DB);
    if (!dataDb) throw new ApiError(404, `data.db not found in container ${containerId}`);

    let versions = await mount.getChildByName(containerId, VERSIONS_FOLDER_NAME);
    if (!versions) {
        const newId = await mount.createFolder(containerId, VERSIONS_FOLDER_NAME);
        const created = await mount.getPath(newId);
        if (!created) throw new ApiError(500, 'Failed to create versions folder');
        versions = created;
    }

    const snapshotName = formatSnapshotTimestamp(new Date());
    // Two snapshots in the same millisecond hold the same state, so the second returns the first.
    const existing = await mount.getChildByName(versions.id, snapshotName);
    if (existing) return existing;
    const versionPathId = mount.uploadQueue
        ? await snapshotDataDbToVersionStaged(mount, mount.uploadQueue, dataDb, versions.id, snapshotName, order)
        : await snapshotDataDbToVersionLocal(mount, dataDb, versions.id, snapshotName, order);
    const copy = await mount.getPath(versionPathId);
    if (!copy) throw new ApiError(500, 'Failed to create version snapshot');

    // A shutdown skips the prune: a stalled DELETE would use up its budget, and the next snapshot prunes anyway.
    if (getShutdownDrainDeadline() !== null) return copy;

    // The new copy stays out of the prune. Retention keeps the newest version of each hour, and a second
    // snapshot in the same hour would otherwise drop the first before the hour is over.
    const toPrune = selectSnapshotsToPrune(
        (await mount.listFolder(versions.id)).filter((version) => version.id !== copy.id),
        policy,
    );
    for (const item of toPrune) await mount.deletePath(item.id);
    return copy;
}

// The s3 version snapshot. It copies the freshest copy of data.db, creates the version's row and queues its
// upload. The caller holds the container lock.
async function snapshotDataDbToVersionStaged(
    mount: Mount,
    queue: UploadQueue,
    dataDb: DrivePath,
    versionsId: string,
    snapshotName: string,
    order: CopyOrder,
): Promise<string> {
    const versionStaging = queue.newStagingPath();
    const staged = await stageManagedDbCopy(mount, dataDb.id, versionStaging, order).catch((error: unknown) => {
        // A failed read leaves a half-written copy no pending upload references.
        fs.rmSync(versionStaging, { force: true });
        throw error;
    });
    if (!staged) throw storageGone();
    const versionPathId = await mount.touchFile(versionsId, snapshotName, dataDb.mimeType);
    const versionKey = await mount.getStorageKey(versionPathId);
    const size = fs.statSync(versionStaging).size;
    await mount.db.update(paths).set({ size, updatedAt: new Date() }).where(eq(paths.id, versionPathId));
    await mount.invalidateAncestorsOf(versionPathId);
    queue.enqueueStaged(versionKey, versionStaging, true);
    return versionPathId;
}

// The version snapshot of a mount without an upload queue. It stages the same freshest copy in tmp/ and
// writes it to storage before it returns.
async function snapshotDataDbToVersionLocal(
    mount: Mount,
    dataDb: DrivePath,
    versionsId: string,
    snapshotName: string,
    order: CopyOrder,
): Promise<string> {
    const tempId = crypto.randomUUID();
    try {
        const tempPath = mount.getTempPath(tempId);
        const staged = await stageManagedDbCopy(mount, dataDb.id, tempPath, order);
        if (!staged) throw storageGone();
        const { size, hash } = staged === 'local' ? await hashFile(tempPath) : staged;
        return await mount.createFileFromTemp(versionsId, snapshotName, dataDb.mimeType, size, hash, tempId);
    } finally {
        await mount.cleanupTemp(tempId);
    }
}

// Copies the current bytes of a container's managed database to destPath. A copy of the stored object answers its size
// and hash, and only that one shows that storage answers. Null: nothing is left to copy, and a version answers 410.
export async function stageManagedDbCopy(
    mount: Mount,
    pathId: string,
    destPath: string,
    order: CopyOrder,
): Promise<'local' | { size: number; hash: string } | null> {
    // 'staged-first' never reads the crash temp. It runs inside a close that holds the slot and removes that temp.
    if (order === 'open-handle-first') {
        const staged = await withDocumentDb(mount, pathId, async (slot) => {
            if (slot.db) {
                slot.db.stageCopy(destPath);
                return true;
            }
            // This runs inside the slot, because an open adopts, rewrites or removes what an unclean shutdown left,
            // and only the slot puts the two in order. Its newest bytes can be read only through SQLite.
            const row = await mount.getPath(pathId);
            if (!row) return false;
            const tempPath = mount.getTempPath(pathId);
            if (!isViableRecoveryTemp(tempPath, row.size ?? 0)) return false;
            // Read-write: a readonly open of a WAL database with no -wal and no -shm fails. The close folds a -wal in.
            const db = new Database(tempPath, { readwrite: true, create: false });
            db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
            try {
                db.run('VACUUM INTO ?', [destPath]);
            } catch (error) {
                throw new Error(`mount ${mount.id}: leftover database ${pathId} at ${tempPath} cannot be copied`, {
                    cause: error,
                });
            } finally {
                db.close(true);
            }
            return true;
        });
        if (staged) return 'local';
    }
    // The shared tree lock, taken after the slot, keeps a rename of a folder above on `local` from moving
    // the object between its key and the read.
    return mount.withTreeShared(async () => {
        const storageKey = await mount.getStorageKey(pathId);
        // The copy is synchronous. With no await between the check in pendingStagedCopy and the copy, an
        // enqueue can't delete the staged copy while it is read.
        const pendingStaging = mount.pendingStagedCopy(storageKey);
        if (pendingStaging) {
            fs.copyFileSync(pendingStaging, destPath);
            return 'local';
        }
        // With no upload pending, an open database is copied with VACUUM INTO. Otherwise the stored object
        // is current, because every upload of it has landed.
        const cached = mount.documentDbs.get(pathId)?.db;
        if (cached) {
            cached.stageCopy(destPath);
            return 'local';
        }
        // A GET, not a HEAD: a HEAD answers a missing bucket as a missing key, and null here is terminal.
        try {
            return await writeTempWithHash(destPath, mount.storage.read(storageKey));
        } catch (error) {
            if (!isMissingObjectCause(error)) throw error;
            fs.rmSync(destPath, { force: true });
            return null;
        }
    });
}

// Replaces the bytes of the container's data.db with a file in tmp/. The row stays, so a backup's copy of metadata.db
// never sees the container without one. The close and the write run in one slot call, so no open comes in between.
export async function replaceContainerDataDb(mount: Mount, containerId: string, sourcePath: string): Promise<void> {
    return mount.withPathLock(containerId, async () => {
        const dataDb = await mount.getChildByName(containerId, CONTAINER_DATA_DB);
        if (!dataDb) throw new ApiError(404, `data.db not found in container ${containerId}`);
        const { size, hash } = await hashFile(sourcePath);
        await withDocumentDb(mount, dataDb.id, async (slot) => {
            // No final snapshot: these bytes are about to go, and a snapshot would take this container lock again.
            await closeInSlot(slot, dataDb.id, { skipFinalSnapshot: true });
            // The next open would adopt a crash temp over the new bytes.
            await mount.cleanupTemp(dataDb.id);
            await mount.withTreeShared(async () => {
                const storageKey = await mount.getStorageKey(dataDb.id);
                if (mount.uploadQueue) {
                    // Through the queue, where it replaces the close's staged copy. That copy's PUT could land
                    // after a direct write and overwrite it.
                    const staging = mount.uploadQueue.newStagingPath();
                    fs.copyFileSync(sourcePath, staging);
                    mount.uploadQueue.enqueueStaged(storageKey, staging, true);
                } else {
                    await mount.storage.write(storageKey, Bun.file(sourcePath));
                }
            });
            await mount.db.update(paths).set({ size, hash, updatedAt: new Date() }).where(eq(paths.id, dataDb.id));
            await mount.invalidateAncestorsOf(dataDb.id);
        });
        // No onSync runs for this write, so the container is marked for a new extract here, as a sync would.
        await markContainerContentDirty(mount, dataDb.id);
    });
}
