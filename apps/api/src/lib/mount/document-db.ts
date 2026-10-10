import * as fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { settlesWithin } from '../../utils/timing';
import {
    ApiError,
    type DatabaseConfig,
    ManagedDatabase,
    type SchemaType,
    type SyncCallbacks,
    storageGone,
    storageUnavailable,
} from '../core';
import { errnoOf } from '../storage';
import { getShutdownDrainDeadline } from '../sync';
import { isViableRecoveryTemp } from './helpers';
import type { Mount } from './mount';
import { paths } from './schema';
import { markContainerContentDirty } from './search-index';

// Managed document-DB lifecycle: the cached working copies behind every container's
// data.db/comments.db — open/create, the onOpen/onSync/onClose callbacks (crash
// recovery, write-behind staging — see docs/SYNC.md), and teardown.

export type DocumentDbSlot = {
    db: ManagedDatabase<SchemaType> | null; // the live instance while open; null while a build or a close is in flight
    tail: Promise<void>; // the lifecycle op in flight; the next op on this pathId queues behind it
    pending: number; // queued + running ops; the slot is dropped when it reaches 0 with db null
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
    return openDocumentDb(mount, config, pathId, 'create');
}

// Every open, create and close of one pathId runs here, one at a time, in call order.
// Lock order: container path lock → slot → tree lock, never the reverse; the close-time snapshot try-locks.
// A chain rather than withPathLock: `has` must also see queued opens and closes.
export async function withDocumentDb<T>(
    mount: Mount,
    pathId: string,
    fn: (slot: DocumentDbSlot) => Promise<T>,
): Promise<T> {
    const slot = mount.documentDbs.get(pathId) ?? { db: null, tail: Promise.resolve(), pending: 0 };
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
    // Seam: documentDbs is one heterogeneous cache (ManagedDatabase<SchemaType>), so the caller's
    // schema S can only be re-attached here — the config that built the entry carries it.
    return withDocumentDb(mount, pathId, async (slot) => {
        if (mount.closing) throw new ApiError(503, 'Mount is closing');
        if (slot.db) {
            if (mode === 'create') throw new Error(`Mount.createDatabase ${pathId}: already in cache`);
            return slot.db as ManagedDatabase<S>;
        }
        const db = await buildDocumentDb(mount, config, pathId, mode);
        slot.db = db;
        return db;
    });
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
              // standalone or already-deleted: 'taken' so the watermark advances and the
              // tick doesn't re-probe every 30s ('skipped' is strictly for lock contention).
              if (!path?.parentId) return 'taken';
              return mount.trySnapshotContainerDataDb(path.parentId, snapshot.policy);
          }
        : undefined;

    // Set when onOpen reuses a temp that survived an unclean shutdown — those bytes
    // never synced, so the DB must be force-dirtied after open (crash recovery, below).
    let recoveredFromCrash = false;

    // Captured by onSync to VACUUM INTO-stage the live DB.
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
                  // isRemote: stage a frozen copy + enqueue, off the request/close path.
                  // Local path-based: keep the synchronous local copy (Bun.write never 503s,
                  // and async-queuing it would only weaken its on-completion durability).
                  onSync: () =>
                      mount.withTreeShared(async () => {
                          // Resolve the key on EVERY sync and under the mount's tree lock: on `local`
                          // it is the hierarchical path, so a move since open, or one landing between
                          // the resolve and the write, would rebuild the old tree and orphan the sync.
                          // A vanished row means the doc was deleted — skip, so a stale sync can't
                          // resurrect a dead key. (s3/local-key keys are id-stable and take no lock.)
                          if (!(await mount.getPath(pathId))) return;
                          const currentKey = await mount.getStorageKey(pathId);
                          if (mount.uploadQueue) {
                              const stagingPath = mount.uploadQueue.newStagingPath();
                              managed.stageCopy(stagingPath);
                              // A VACUUM INTO copy of a managed database, so the queue holds it to the
                              // SQLite header check before the PUT (schema.ts, `isDatabase`).
                              mount.uploadQueue.enqueueStaged(currentKey, stagingPath, true);
                              // The staged copy is the object ranges and HEAD are served against; the queue unlinks it only after its PUT.
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
                      // A failed final sync means the temp is the only copy holding the tail —
                      // leave it as the unclean-shutdown marker (adopted + re-synced
                      // on the next open), never delete it.
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
    await withDocumentDb(mount, pathId, async (slot) => {
        const db = slot.db;
        if (!db) return;
        // Cleared BEFORE closing: a snapshot read mid-close must not see the closing instance.
        slot.db = null;
        await db.close(opts);
    });
}

// Flush + close every cached document DB at or below `rootId` (the container's own data.db, its
// comments.db, any nested doc/chat). The documentDbs cache is otherwise decoupled from row
// mutations — trash/delete change rows without it noticing — so a still-open dirty DB keeps its
// 30s timer alive and syncs data.db to the pre-mutation key: a zombie tree on `local`, a
// resurrected object on `s3`. Callers invoke this while the rows still exist (the walk needs
// them): trashPath before the storage rename so the final bytes ride into .trash/ with the rest;
// deletePath before the row/storage removal so cancel()/deleteDir() then clears what was flushed.
// Yjs collab docs are already torn down by Drive.closeCollabDocumentsRecursively; this catches
// the rest (chat data.db, comments.db). skipFinalSnapshot: the container is going away, and a
// snapshot would re-enter its path lock.
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

    // Cancel the init-scheduled history prune so a fast teardown doesn't fire it against a
    // metadata.db the Home is about to close (the mount stops its own timers here — the same seam
    // as the upload/reindex queues below).
    if (mount.pruneTimer) {
        clearTimeout(mount.pruneTimer);
        mount.pruneTimer = null;
    }

    // Reindex FIRST, awaiting its in-flight drain: an extract mid-await opens a doc DB via
    // openDatabase and leaves it for the mount lifecycle to close. Draining before the sweep below
    // means that last-extract DB lands in the map and is closed by it — an open landing after the
    // gate below is refused (else 30s timer, fd, temp; dirty syncs into a closed metadata.db).
    // Leftover dirty rows still replay on the next open (only the current extract is drained, not
    // the backlog). The await is deadline-bounded so a black-holed extract can't park teardown (see
    // ContentReindexQueue.close).
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

// Update paths.size for a ManagedDatabase row from disk, then invalidate
// ancestors — eigendoc containers stay in sync with data.db growth.
async function syncDocumentDbSize(mount: Mount, pathId: string, localPath: string): Promise<void> {
    if (!fs.existsSync(localPath)) {
        console.warn(`[Mount] syncDocumentDbSize ${pathId}: localPath missing at ${localPath}`);
        return;
    }
    const size = fs.statSync(localPath).size;
    await mount.db.update(paths).set({ size, updatedAt: new Date() }).where(eq(paths.id, pathId));
    await mount.invalidateAncestorsOf(pathId);
}
