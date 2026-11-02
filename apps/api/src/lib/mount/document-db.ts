// The document databases of a mount, such as a container's data.db and comments.db. Each one is a
// SQLite working copy that is opened from storage, synced back to it and closed, one call at a time per
// path. A reader holds one only while it runs, and the database closes after a few idle minutes without
// holders. Mount is how callers reach it, and closeAllDatabases tears every one down when a Home closes
// or a mount goes away.

import * as fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { settlesWithin } from '../../utils/timing';
import type { DatabaseConfig, SchemaType, SyncCallbacks } from '../core';
import { ApiError, ManagedDatabase, storageGone, storageUnavailable } from '../core';
import { errnoOf } from '../storage';
import { isViableRecoveryTemp } from './helpers';
import type { Mount } from './mount';
import { paths } from './schema';
import { markContainerContentDirty } from './search-index';
import { getShutdownDrainDeadline } from './upload-limits';

// A database with no holder stays open as long as an idle Home does, five minutes. A close takes a
// version snapshot, and on s3, or on a local mount that works on a temp copy, it is also an upload. So
// a chat that gets a message now and then must not pay that for each one. The content reindex reads a
// changed container again two minutes later, and it must not reopen what the idle close just closed.
export const IDLE_CLOSE_MS = 5 * 60_000;
// A close waits this long for the holders to let go. Then it closes anyway and logs, so a holder that
// hangs can't hang a shutdown.
export const HOLDER_WAIT_MS = 5_000;

export type DocumentDbSlot = {
    db: ManagedDatabase<SchemaType> | null; // the live instance while open; null while a build or a close is in flight
    tail: Promise<void>; // the lifecycle op in flight; the next op on this pathId queues behind it
    pending: number; // queued + running ops; the slot is dropped when it reaches 0 with db null
    holders: number; // the callers using db right now, such as a withDatabase reader or an open collab document
    idleTimer: ReturnType<typeof setTimeout> | null; // the close armed when the last holder let go
    lastHolderGone: (() => void) | null; // set while a close waits for the holders
};

// A database a caller holds open, and the call that lets go of it.
export type DatabaseHold<S extends SchemaType> = {
    db: ManagedDatabase<S>;
    release: () => void;
};

export async function openDatabase<S extends SchemaType>(
    mount: Mount,
    config: DatabaseConfig<S>,
    pathId: string,
): Promise<ManagedDatabase<S>> {
    return openDocumentDb(mount, config, pathId, 'open');
}

export async function createDatabase<S extends SchemaType>(
    mount: Mount,
    config: DatabaseConfig<S>,
    pathId: string,
): Promise<ManagedDatabase<S>> {
    if (mount.documentDbs.has(pathId)) {
        throw new Error(`Mount.createDatabase ${pathId}: already in cache`);
    }
    return withDocumentDb(mount, pathId, async (slot) => {
        const db = await openInSlot(mount, slot, config, pathId, 'create');
        // Nobody holds a database that was just made, so it closes when idle, as after a last reader.
        if (slot.holders === 0) armIdleClose(mount, pathId, slot);
        return db;
    });
}

// Runs fn with the database open, and closes it IDLE_CLOSE_MS after the last holder lets go. A close
// that comes meanwhile waits for fn, inside the slot and maybe under the container path lock, so fn
// must never take that path lock or call withDatabase for the same pathId.
export async function withDatabase<S extends SchemaType, T>(
    mount: Mount,
    config: DatabaseConfig<S>,
    pathId: string,
    fn: (db: ManagedDatabase<S>) => Promise<T>,
): Promise<T> {
    const hold = await holdDatabase(mount, config, pathId);
    try {
        return await fn(hold.db);
    } finally {
        hold.release();
    }
}

// withDatabase for a holder that outlives one call, such as an open collab document, which writes
// every edit to its data.db. It lets go in its own close, before it closes the database. What closes
// such a database, such as a trash, closes the document first. So this holder alone may take the
// container path lock while it holds, as a workbook's version before its compaction does. Only a
// document that moves into a folder while the folder is trashed makes a close wait out HOLDER_WAIT_MS.
export async function holdDatabase<S extends SchemaType>(
    mount: Mount,
    config: DatabaseConfig<S>,
    pathId: string,
): Promise<DatabaseHold<S>> {
    return withDocumentDb(mount, pathId, async (slot) => {
        const db = await openInSlot(mount, slot, config, pathId, 'open');
        slot.holders++;
        if (slot.idleTimer) clearTimeout(slot.idleTimer);
        slot.idleTimer = null;
        // A second call of release must not let go for another holder.
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            releaseHold(mount, pathId, slot);
        };
        return { db, release };
    });
}

// Every open, create and close of one pathId runs here, one at a time, in call order.
// Lock order: container path lock → slot → tree lock, never the reverse; the close-time snapshot try-locks.
// A chain rather than withPathLock: `has` must also see queued opens and closes.
export async function withDocumentDb<T>(
    mount: Mount,
    pathId: string,
    fn: (slot: DocumentDbSlot) => Promise<T>,
): Promise<T> {
    const slot = mount.documentDbs.get(pathId) ?? {
        db: null,
        tail: Promise.resolve(),
        pending: 0,
        holders: 0,
        idleTimer: null,
        lastHolderGone: null,
    };
    mount.documentDbs.set(pathId, slot);
    slot.pending++;
    const run = slot.tail.then(() => fn(slot));
    slot.tail = run.then(
        () => {},
        () => {},
    );
    try {
        return await run;
    } finally {
        if (--slot.pending === 0 && slot.db === null) mount.documentDbs.delete(pathId);
    }
}

async function openDocumentDb<S extends SchemaType>(
    mount: Mount,
    config: DatabaseConfig<S>,
    pathId: string,
    mode: 'open' | 'create',
): Promise<ManagedDatabase<S>> {
    return withDocumentDb(mount, pathId, (slot) => openInSlot(mount, slot, config, pathId, mode));
}

async function openInSlot<S extends SchemaType>(
    mount: Mount,
    slot: DocumentDbSlot,
    config: DatabaseConfig<S>,
    pathId: string,
    mode: 'open' | 'create',
): Promise<ManagedDatabase<S>> {
    if (mount.closing) throw new ApiError(503, 'Mount is closing');
    if (slot.db) {
        if (mode === 'create') throw new Error(`Mount.createDatabase ${pathId}: already in cache`);
        // Seam: documentDbs is one heterogeneous cache (ManagedDatabase<SchemaType>), so the caller's
        // schema S can only be re-attached here — the config that built the entry carries it.
        return slot.db as ManagedDatabase<S>;
    }
    const db = await buildDocumentDb(mount, config, pathId, mode);
    slot.db = db;
    return db;
}

// The last holder to let go wakes a close that waits for it, or else arms the idle close.
function releaseHold(mount: Mount, pathId: string, slot: DocumentDbSlot): void {
    if (--slot.holders > 0) return;
    if (slot.lastHolderGone) {
        slot.lastHolderGone();
        return;
    }
    armIdleClose(mount, pathId, slot);
}

// Closes the slot's database IDLE_CLOSE_MS from now, unless a holder comes back first.
function armIdleClose(mount: Mount, pathId: string, slot: DocumentDbSlot): void {
    if (!slot.db) return;
    slot.idleTimer = setTimeout(() => {
        slot.idleTimer = null;
        withDocumentDb(mount, pathId, async (current) => {
            // A holder came back meanwhile, or this slot was closed and a new one took its place.
            if (current === slot && slot.holders === 0) await closeInSlot(slot, pathId);
        }).catch((error: unknown) => console.error(`[Mount] idle close failed for ${pathId}:`, error));
    }, IDLE_CLOSE_MS);
    // An idle database must never keep the process alive.
    slot.idleTimer.unref();
}

async function buildDocumentDb<S extends SchemaType>(
    mount: Mount,
    config: DatabaseConfig<S>,
    pathId: string,
    mode: 'open' | 'create',
): Promise<ManagedDatabase<S>> {
    const storageKey = await mount.getStorageKey(pathId);
    // local-key is the only backend that skips the temp copy, and its LocalStorage always exposes
    // getPath (optional on StorageBackend because s3 has no local file).
    let localPath: string;
    if (mount.needsTempCopy) localPath = mount.getTempPath(pathId);
    else if (mount.storage.getPath) localPath = mount.storage.getPath(storageKey);
    else throw new Error(`Mount.${mode}Database ${pathId}: storage backend exposes no local path`);

    if (mode === 'create') {
        if (await mount.storage.exists(storageKey)) {
            throw new Error(`Mount.createDatabase ${pathId}: storage object ${storageKey} already exists`);
        }
    } else if (!mount.needsTempCopy) {
        // Only absence is gone: EACCES or EIO (a volume gone away) is an outage the client retries.
        try {
            fs.statSync(localPath);
        } catch (error) {
            throw errnoOf(error) === 'ENOENT' ? storageGone(error) : storageUnavailable(error);
        }
    }

    const snapshot = config.snapshot;
    const onSnapshot: SyncCallbacks['onSnapshot'] = snapshot
        ? async () => {
              const path = await mount.getPath(pathId);
              // A database outside a container, or one whose row is gone, has nothing to snapshot.
              // It answers 'taken', so the watermark moves and the tick doesn't try again every 30 s.
              // 'skipped' means only that the container lock was busy.
              if (!path?.parentId) return 'taken';
              return mount.trySnapshotContainerDataDb(path.parentId, snapshot.policy);
          }
        : undefined;

    // Set when onOpen adopts a temp that an unclean shutdown left. Those bytes never synced, so the
    // database is marked dirty after the open.
    let recoveredFromCrash = false;

    // onSync stages a copy of this live database with VACUUM INTO.
    const managed = new ManagedDatabase(
        config,
        localPath,
        mount.needsTempCopy
            ? {
                  onOpen: async () => {
                      if (mode === 'create') return;
                      const tempPath = mount.getTempPath(pathId);
                      if (fs.existsSync(tempPath)) {
                          // A surviving temp signals an unclean shutdown. Adopt it only if it's a real,
                          // non-collapsed SQLite: a 0-byte, partial or fresh-init temp (a failed or empty
                          // S3 GET) would be uploaded as an empty doc over the good stored object.
                          const known = await mount.getPath(pathId);
                          if (isViableRecoveryTemp(tempPath, known?.size ?? 0)) {
                              console.log(`[Mount] Recovering from crash: using existing tmp file for ${pathId}`);
                              recoveredFromCrash = true;
                              return;
                          }
                          const tempSize = fs.statSync(tempPath).size;
                          console.warn(
                              `[Mount] Discarding unusable crash temp for ${pathId} ` +
                                  `(temp=${tempSize}B, stored=${known?.size ?? 0}B); re-fetching from storage`,
                          );
                          await mount.cleanupTemp(pathId);
                      }
                      // Under the tree lock, as onSync: on `local` an ancestor rename racing the download
                      // would read as a miss.
                      await mount.withTreeShared(async () => {
                          const currentKey = await mount.getStorageKey(pathId);
                          // Clean close during an outage: the live temp was cleaned but a staged
                          // copy holds bytes newer than storage (upload not yet acked). Recover
                          // from it rather than downloading a stale object.
                          const staged = mount.pendingStagedCopy(currentKey);
                          if (staged) {
                              console.log(`[Mount] Recovering from staged upload for ${pathId}`);
                              await mount.cleanupTemp(pathId);
                              await mount.replaceTempFrom(pathId, Bun.file(staged));
                              return;
                          }
                          // The open sends no HEAD: the GET itself answers a gone object (410).
                          await mount.downloadKeyToTemp(currentKey, pathId);
                          // No empty-check here: an empty 200 is caught by ManagedDatabase's
                          // mustExist guard (openCold refuses to open an empty working copy as a fresh db).
                      });
                  },
                  // On s3 the sync stages a frozen copy and queues its upload, off the request and close
                  // path. On a path-based local mount it copies at once: a local write never answers
                  // 503, and a queue would only make the copy less durable when the sync returns.
                  onSync: () =>
                      mount.withTreeShared(async () => {
                          // The key is resolved on every sync, under the tree lock. On `local` it is the
                          // name path, so a move since the open, or during the sync, would write the old
                          // tree back. A missing row means the document was deleted, and a sync then
                          // must not bring its key back. Keys on s3 and local-key never change.
                          const currentKey = await mount.findStorageKey(pathId);
                          if (currentKey === null) return;
                          if (mount.uploadQueue) {
                              const stagingPath = mount.uploadQueue.newStagingPath();
                              managed.stageCopy(stagingPath);
                              // A VACUUM INTO copy of a managed database, so the queue holds it to the
                              // SQLite header check before the PUT (schema.ts, `isDatabase`).
                              mount.uploadQueue.enqueueStaged(currentKey, stagingPath, true);
                              // Ranges and HEAD are served from the staged copy until its PUT lands. The queue
                              // removes it only after that.
                              await syncDocumentDbSize(mount, pathId, stagingPath);
                          } else {
                              await mount.uploadFromTemp(currentKey, pathId);
                              await syncDocumentDbSize(mount, pathId, localPath);
                          }
                          await markContainerContentDirty(mount, pathId);
                      }),
                  // Re-stat only where the live file is the object; a queued row already matches its staged copy.
                  onClose: async (syncFailed) => {
                      if (!mount.uploadQueue) await syncDocumentDbSize(mount, pathId, localPath);
                      // After a failed final sync the temp is the only copy of the newest writes. It
                      // stays as the crash temp, which the next open adopts and syncs again.
                      if (!syncFailed) await mount.cleanupTemp(pathId);
                  },
                  onSnapshot,
              }
            : {
                  onSync: async () => {
                      await syncDocumentDbSize(mount, pathId, localPath);
                      await markContainerContentDirty(mount, pathId);
                  },
                  onClose: async () => {
                      await syncDocumentDbSize(mount, pathId, localPath);
                  },
                  onSnapshot,
              },
        mode === 'open',
    );

    await managed.open();

    // A recovered temp may hold writes storage lacks, but the fresh connection's total_changes() is 0, so
    // the close-time cleanupTemp would drop them. Force the next sync.
    if (recoveredFromCrash) {
        managed.markDirty();
    }

    // For temp-copy backends (s3, path-based local), push the freshly-created schema to storage before
    // returning. Local-key writes go straight to the backing file so no flush is needed. Without this, the
    // storage object only appears on the next 30s sync — and an API restart in that window would make
    // subsequent strict openDatabase calls throw.
    if (mode === 'create' && mount.needsTempCopy) {
        try {
            await managed.flush();
        } catch (err) {
            // No slot holds it yet: close it here or its connection, timer and journals leak.
            await managed.close({ skipFinalSnapshot: true }).catch(() => {});
            throw err;
        }
    }

    return managed;
}

export async function closeDatabase(
    mount: Mount,
    pathId: string,
    opts?: { skipFinalSnapshot?: boolean },
): Promise<void> {
    if (!mount.documentDbs.has(pathId)) return;
    await withDocumentDb(mount, pathId, (slot) => closeInSlot(slot, pathId, opts));
}

// Closes the slot's database once its holders let go, or after HOLDER_WAIT_MS. The caller runs it
// inside the slot, so no new holder arrives while it waits.
export async function closeInSlot(
    slot: DocumentDbSlot,
    pathId: string,
    opts?: { skipFinalSnapshot?: boolean },
): Promise<void> {
    const db = slot.db;
    if (!db) return;
    if (slot.holders > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        slot.lastHolderGone = resolve;
        const released = await settlesWithin(promise, HOLDER_WAIT_MS);
        slot.lastHolderGone = null;
        if (!released) console.warn(`[Mount] closing ${pathId} while ${slot.holders} holder(s) still use it`);
    }
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    // Cleared BEFORE closing: a snapshot read mid-close must not see the closing instance.
    slot.db = null;
    await db.close(opts);
}

// Syncs and closes every open document database at or below rootId, such as a container's data.db
// and comments.db and those of a nested chat. A trash or a delete changes rows without the cache
// knowing. A dirty database left open would then sync to the old key on its next tick, which writes
// a dead tree back on `local` and a deleted object back on `s3`. The walk needs the rows, so callers
// run this before they change them: trashPath before its storage rename, so the last bytes move to
// the trash with the rest, and deletePath before it removes rows and bytes. Open collab documents
// are closed before this, so it closes what readers and chats left open. skipFinalSnapshot: the
// container is going away, and a snapshot would take its path lock again.
export async function closeCachedDbsUnder(mount: Mount, rootId: string): Promise<void> {
    for (const id of [rootId, ...mount.collectDescendantIds(rootId)]) {
        if (mount.documentDbs.has(id)) {
            await closeDatabase(mount, id, { skipFinalSnapshot: true });
        }
    }
}

export async function closeAllDatabases(mount: Mount): Promise<void> {
    // First, so neither the reindex drain nor a close below waits on a download. The mount is not
    // reused after this, so the abort is for good.
    mount.downloads.abort();
    // The abort stops the trash purge between items. The one in flight finishes before metadata.db closes.
    await mount.trashPurge;

    // The history prune that init scheduled is cancelled, so a fast teardown doesn't run it against a
    // metadata.db the Home is about to close.
    if (mount.pruneTimer) {
        clearTimeout(mount.pruneTimer);
        mount.pruneTimer = null;
    }

    // The reindex closes first, and the extract in flight finishes. That extract may hold a document
    // database, and the sweep below would otherwise wait for it. An open that lands after the gate
    // below is refused. Only the current extract is drained, so the other dirty rows replay on the
    // next open. The wait has a deadline, so an extract that hangs can't park the teardown.
    await mount.reindexQueue?.close();

    // Thumbnail jobs end with getPath/updatePath on metadata.db and hold a sharp worker; each is
    // bounded by the worker's own timeout (see thumbnails.ts).
    await Promise.allSettled(mount.thumbnailJobs);

    mount.closing = true;
    // The live map, not a copy, so a slot added mid-sweep is visited; an open that queues behind a
    // swept close is refused by the gate.
    for (const pathId of mount.documentDbs.keys()) {
        try {
            await closeDatabase(mount, pathId); // isRemote: onClose-time sync stages + enqueues the final state
        } catch (err) {
            console.error(`[Mount] closeAllDatabases close failed for ${pathId}:`, err);
        }
    }

    if (mount.uploadQueue) {
        // Process shutdown only: flush the queue AFTER the final close-time enqueues, so healthy
        // uploads finish before metadata.db closes. The wait ends at the global deadline even with a
        // PUT or a semaphore slot stalled; close() then stops the loop and a late PUT skips its ack,
        // so leftover rows replay on boot. Idle teardown leaves the deadline null and skips the flush.
        const deadline = getShutdownDrainDeadline();
        if (deadline !== null) {
            await settlesWithin(
                mount.uploadQueue
                    .drain({ flushNow: true })
                    .catch((e) => console.error(`[Mount] shutdown drain failed:`, e)),
                Math.max(0, deadline - Date.now()),
            );
        }
        mount.uploadQueue.close();
    }
}

// Copies the database file's size into its paths row and refreshes the folder sizes above it, so a
// container's size follows its data.db.
async function syncDocumentDbSize(mount: Mount, pathId: string, localPath: string): Promise<void> {
    if (!fs.existsSync(localPath)) {
        console.warn(`[Mount] syncDocumentDbSize ${pathId}: localPath missing at ${localPath}`);
        return;
    }
    const size = fs.statSync(localPath).size;
    await mount.db.update(paths).set({ size, updatedAt: new Date() }).where(eq(paths.id, pathId));
    await mount.invalidateAncestorsOf(pathId);
}
