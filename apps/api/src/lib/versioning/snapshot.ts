import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eq } from 'drizzle-orm';
import { ApiError } from '../core';
import { writeTempWithHash } from '../drive/streaming';
import type { Mount } from '../mount/mount';
import { paths } from '../mount/schema';
import { markContainerContentDirty } from '../mount/search-index';
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
    return mount.withPathLock(containerId, () =>
        takeSnapshot(mount, containerId, policy, { awaitInFlightClose: true }),
    );
}

// The tick/close (ManagedDatabase onSnapshot) twin: those snapshots must never PARK on the
// container lock — a close already holds the doc's closing slot, so waiting on a lock whose
// holder waits on that same close deadlocks (the H→F→C cycle in the design note). A skip
// forgoes at most one version-history entry, never bytes (the sync already staged them);
// a tick-path skip retries next tick because snapshotIfDue doesn't advance on 'skipped'.
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
    opts?: { awaitInFlightClose?: boolean },
): Promise<DrivePath> {
    const dataDb = await mount.getChildByName(containerId, 'data.db');
    if (!dataDb) throw new ApiError(404, `data.db not found in container ${containerId}`);

    // A registry close never takes the container lock, and delete-before-close empties
    // the documentDbs slot — mid-close the peek below finds nothing, so the copy would
    // source staged/storage bytes predating the close's final sync (or, on local
    // backends, overlap its checkpoint: a torn versions/ entry). The blocking path
    // (manual save, pre-restore snapshot) waits out such an in-flight close: that close
    // is never its own, and a close never parks on this container lock (its own snapshot
    // try-locks and skips), so there is no cycle. The tick/close path must NOT wait —
    // a close-time snapshot runs inside the very close that registered the slot, and
    // awaiting it would wedge on itself. The close's error stays with its own caller.
    if (opts?.awaitInFlightClose) {
        const closing = mount.closingDocumentDbs.get(dataDb.id);
        if (closing) await closing.catch(() => {});
    }

    // Flush any cached managedDb so the on-storage data.db reflects pending
    // writes. No-op if not cached, or cached and not dirty. peek(), never the
    // getter: mid-close the map holds an unresolved factory awaiting this very
    // close's deferred (C→F→C wedge), and an unresolved getter has no live db
    // with pending writes — the staged-copy/storage fallback reads current bytes.
    const cached = mount.documentDbs.get(dataDb.id)?.peek();
    if (cached) await cached.flush();

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
    // isRemote sources the version from the freshest LOCAL bytes and ENQUEUES its upload
    // (§3), so a close-time snapshot never blocks on the backend — copyPath would instead
    // write the new version to storage synchronously. Local backends are synchronously
    // current, so they keep the direct copyPath.
    const copy = mount.isRemote
        ? await snapshotDataDbToVersionStaged(mount, dataDb, versions.id, snapshotName)
        : await mount.copyPath(dataDb.id, versions.id, snapshotName);

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

// isRemote version snapshot: create the version metadata row, source its bytes from the
// freshest LOCAL copy of data.db, and enqueue the upload (so a close-time snapshot never
// blocks on the backend). Caller holds the container lock.
async function snapshotDataDbToVersionStaged(
    mount: Mount,
    dataDb: DrivePath,
    versionsId: string,
    snapshotName: string,
): Promise<DrivePath> {
    const versionPathId = await mount.touchFile(versionsId, snapshotName, dataDb.mimeType);
    const versionKey = await mount.getStorageKey(versionPathId);
    const queue = mount.uploadQueue!; // isRemote-only path (snapshotContainerDataDb branch)
    const versionStaging = queue.newStagingPath();
    await stageDataDbSnapshot(mount, dataDb.id, versionStaging);
    const size = fs.statSync(versionStaging).size;
    await mount.db.update(paths).set({ size, updatedAt: new Date() }).where(eq(paths.id, versionPathId));
    await mount.invalidateAncestorsOf(versionPathId);
    queue.enqueueStaged(versionKey, versionStaging);
    const created = await mount.getPath(versionPathId);
    if (!created) throw new ApiError(500, 'Failed to create version snapshot');
    return created;
}

// Produce a local copy of data.db's current bytes at destPath, freshest source first.
async function stageDataDbSnapshot(mount: Mount, dataDbPathId: string, destPath: string): Promise<void> {
    const storageKey = await mount.getStorageKey(dataDbPathId);
    // The caller (snapshotContainerDataDb) flushed the cached db first, so the pending staged
    // copy already holds the current bytes — reuse it instead of a second VACUUM INTO. Copy it
    // SYNCHRONOUSLY: with no await between pendingStagedCopy's existsSync and the copy, a
    // concurrent enqueue can't unlink it mid-read.
    const pendingStaging = mount.pendingStagedCopy(storageKey);
    if (pendingStaging) {
        fs.copyFileSync(pendingStaging, destPath);
        return;
    }
    // Nothing pending: a live VACUUM INTO if the doc is open, else the storage object — which is
    // current because every upload acked (§3). peek() as in takeSnapshot's flush step: awaiting
    // an unresolved factory mid-close wedges on the close's own deferred (C→F→C), and an
    // unresolved getter has no live db with pending writes anyway.
    const cached = mount.documentDbs.get(dataDbPathId)?.peek();
    if (cached) {
        cached.stageCopy(destPath);
        return;
    }
    await Bun.write(destPath, mount.storage.read(storageKey));
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
