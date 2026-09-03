import * as fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { createAsyncSingleton } from '../../utils/singleton';
import { ApiError, type DatabaseConfig, ManagedDatabase, type SchemaType, type SyncCallbacks } from '../core';
import { getShutdownDrainDeadline } from '../sync';
import { isViableRecoveryTemp } from './helpers';
import type { Mount } from './mount';
import { paths } from './schema';
import { markContainerContentDirty } from './search-index';

// Managed document-DB lifecycle: the cached working copies behind every container's
// data.db/comments.db — open/create, the onOpen/onSync/onClose callbacks (crash
// recovery Phase 1a, write-behind staging Phase 1b — see docs/SYNC.md), and teardown.

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

async function openDocumentDb<S extends SchemaType>(
    mount: Mount,
    config: DatabaseConfig<S>,
    pathId: string,
    mode: 'open' | 'create',
): Promise<ManagedDatabase<S>> {
    let getter = mount.documentDbs.get(pathId);
    if (!getter) {
        getter = createAsyncSingleton(async () => {
            // Captured synchronously with the map-set and first getter() call below (one
            // synchronous block): any close that grabs THIS factory as its getter registers
            // strictly after this capture, so the captured close can never transitively
            // await this factory — exactly one entry to wait on, no loop, no cycle.
            const closing = mount.closingDocumentDbs.get(pathId);
            // An in-flight close of the same pathId still owns files the fresh instance
            // would share — the live temp (local/s3) or the backing file's journals
            // (local-key) — so building over it loses the tail. Backend-unconditional.
            // The close's error stays with its own caller; the open builds regardless.
            if (closing) await closing.catch(() => {});
            // Clean up the map entry if the factory throws — otherwise a
            // failed createDatabase leaves a getter behind whose closed-over
            // `mode` would silently steer the next openDatabase down the
            // create path.
            try {
                return await buildDocumentDb(mount, config, pathId, mode);
            } catch (err) {
                mount.documentDbs.delete(pathId);
                throw err;
            }
        });
        mount.documentDbs.set(pathId, getter);
    }
    // Seam: documentDbs is one heterogeneous cache (ManagedDatabase<SchemaType>), so the caller's
    // schema S can only be re-attached here — the config that built the entry carries it.
    return getter() as Promise<ManagedDatabase<S>>;
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
    } else if (!mount.needsTempCopy && !(await mount.storage.exists(storageKey))) {
        throw new ApiError(503, `Storage object for ${pathId} not available`);
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
    // never synced, so the DB must be force-dirtied after open (Phase 1a, below).
    let recoveredFromCrash = false;

    // Captured by onSync to VACUUM INTO-stage the live DB (Phase 1b).
    const managed = new ManagedDatabase(
        config,
        localPath,
        mount.needsTempCopy
            ? {
                  onOpen: async () => {
                      if (mode === 'create') return;
                      const tempPath = mount.getTempPath(pathId);
                      if (fs.existsSync(tempPath)) {
                          // A surviving temp signals an unclean shutdown. Adopt it as recovered live
                          // state ONLY if it's a real, non-collapsed SQLite. A 0-byte/partial/fresh-init
                          // temp (e.g. from a failed or empty S3 GET) must NOT be opened as an empty doc
                          // and re-uploaded over the good stored object (the 2026-06-08 wipe) — discard
                          // it and fall through to the authoritative copy.
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
                          fs.rmSync(tempPath, { force: true });
                      }
                      // Clean close during an outage: the live temp was cleaned but a staged
                      // copy holds bytes newer than storage (upload not yet acked). Recover
                      // from it rather than downloading a stale object.
                      if (mount.uploadQueue) {
                          const staged = mount.uploadQueue.getPendingStagingPath(storageKey);
                          if (staged && fs.existsSync(staged)) {
                              console.log(`[Mount] Recovering from staged upload for ${pathId}`);
                              await Bun.write(tempPath, Bun.file(staged));
                              return;
                          }
                      }
                      if (!(await mount.storage.exists(storageKey))) {
                          throw new ApiError(503, `Storage object for ${pathId} not available`);
                      }
                      await mount.downloadKeyToTemp(storageKey, pathId);
                      // No empty-check here: a 0-byte/partial GET is caught by ManagedDatabase's
                      // mustExist guard (openCold refuses to open an empty working copy as a fresh db).
                  },
                  // isRemote: stage a frozen copy + enqueue, off the request/close path.
                  // Local path-based: keep the synchronous local copy (Bun.write never 503s,
                  // and async-queuing it would only weaken its on-completion durability).
                  onSync: async () => {
                      // Resolve the key on EVERY sync, never the once-captured one: on `local` it
                      // is the hierarchical path, so a move/rename since open would otherwise write
                      // data.db to the pre-move location (a zombie tree, silently rebuilt via
                      // createPath:true) and orphan every post-move edit. A vanished row means the
                      // doc was deleted — skip, so a stale sync can't resurrect a dead key.
                      // (s3/local-key keys are id-stable, so this re-resolves to the same value.)
                      if (!(await mount.getPath(pathId))) return;
                      const currentKey = await mount.getStorageKey(pathId);
                      if (mount.uploadQueue) {
                          const stagingPath = mount.uploadQueue.newStagingPath();
                          managed.stageCopy(stagingPath);
                          mount.uploadQueue.enqueueStaged(currentKey, stagingPath);
                      } else {
                          await mount.uploadFromTemp(currentKey, pathId);
                      }
                      await syncDocumentDbSize(mount, pathId, localPath);
                      await markContainerContentDirty(mount, pathId);
                  },
                  // onClose runs after wal_checkpoint(TRUNCATE), so the final stat captures
                  // any pages PASSIVE left in WAL. cleanupTemp is safe under async: the
                  // staged copy (not the live temp) is the upload payload.
                  onClose: async (syncFailed) => {
                      await syncDocumentDbSize(mount, pathId, localPath);
                      // A failed final sync means the temp is the only copy holding the tail —
                      // leave it as the Phase 1a unclean-shutdown marker (adopted + re-synced
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

    // Phase 1a (crash-recovery durability): a surviving temp means a prior process
    // died before its writes synced. The fresh connection's total_changes() reset to
    // 0, so the DB looks clean and the close-time cleanupTemp would silently drop
    // those bytes (the most plausible cause of the 2026-05-30 chat loss). Force the
    // next sync so they re-reach storage. Safe because a clean close always
    // cleanupTemp's the temp — a surviving temp is always an unclean-shutdown signal.
    if (recoveredFromCrash) {
        managed.markDirty();
    }

    // For temp-copy backends (s3, path-based local), push the freshly-created schema to storage before
    // returning. Local-key writes go straight to the backing file so no flush is needed. Without this, the
    // storage object only appears on the next 30s sync — and an API restart in that window would make
    // subsequent strict openDatabase calls throw.
    if (mode === 'create' && mount.needsTempCopy) {
        await managed.flush();
    }

    return managed;
}

export async function closeDatabase(
    mount: Mount,
    pathId: string,
    opts?: { skipFinalSnapshot?: boolean },
): Promise<void> {
    const getter = mount.documentDbs.get(pathId);
    if (!getter) return;
    // Delete BEFORE closing — a concurrent openDatabase() during the async
    // close must create a fresh ManagedDatabase, not reuse the closing one.
    mount.documentDbs.delete(pathId);
    // Registered synchronously (before the first await) so the fresh open that
    // delete-before-close enables waits for this close's file teardown instead of
    // adopting the live temp / sharing its journals (see openDocumentDb).
    let settle!: () => void;
    const closing = new Promise<void>((r) => {
        settle = r;
    });
    mount.closingDocumentDbs.set(pathId, closing);
    try {
        const db = await getter();
        await db.close(opts);
    } finally {
        // Resolve in finally: a throwing close must not wedge waiters (the error still
        // propagates to this close's caller). Delete only our own registration — a nested
        // close may have overwritten the slot, and clobbering its entry would reopen the
        // unguarded window.
        settle();
        if (mount.closingDocumentDbs.get(pathId) === closing) {
            mount.closingDocumentDbs.delete(pathId);
        }
    }
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
    // Cancel the init-scheduled history prune so a fast teardown doesn't fire it against a
    // metadata.db the Home is about to close (the mount stops its own timers here — the same seam
    // as the upload/reindex queues below).
    if (mount.pruneTimer) {
        clearTimeout(mount.pruneTimer);
        mount.pruneTimer = null;
    }

    // Reindex FIRST, awaiting its in-flight drain: an extract mid-await opens a doc DB via
    // openDatabase and leaves it for the mount lifecycle to close. Draining before we snapshot
    // documentDbs means that last-extract DB lands in the map and is closed by the pass below —
    // closing the queue last (after the clear) would let the post-clear open leak (30s timer, fd,
    // temp; dirty syncs into a closed metadata.db). Leftover dirty rows still replay on the next
    // open (only the current extract is drained, not the backlog). The await is deadline-bounded
    // so a black-holed extract can't park teardown (see ContentReindexQueue.close).
    await mount.reindexQueue?.close();

    // Snapshot + clear + register a closing deferred for EVERY pathId in one synchronous
    // block — per-iteration registration would leave later pathIds raceable during the
    // earlier closes' awaits.
    const closes: {
        pathId: string;
        getter: () => Promise<ManagedDatabase<SchemaType>>;
        closing: Promise<void>;
        settle: () => void;
    }[] = [];
    for (const [pathId, getter] of mount.documentDbs) {
        let settle!: () => void;
        const closing = new Promise<void>((r) => {
            settle = r;
        });
        mount.closingDocumentDbs.set(pathId, closing);
        closes.push({ pathId, getter, closing, settle });
    }
    mount.documentDbs.clear();
    for (const { pathId, getter, closing, settle } of closes) {
        try {
            const db = await getter();
            await db.close(); // isRemote: onClose-time sync stages + enqueues the final state
        } catch (err) {
            console.error(`[Mount] closeAllDatabases close failed for ${pathId}:`, err);
        } finally {
            // Resolve in finally + identity-guarded delete, as in closeDatabase.
            settle();
            if (mount.closingDocumentDbs.get(pathId) === closing) {
                mount.closingDocumentDbs.delete(pathId);
            }
        }
    }

    if (mount.uploadQueue) {
        // Process shutdown only: flush the queue (bounded by the global deadline) AFTER the
        // final close-time enqueues, so healthy uploads finish before metadata.db closes.
        // Idle teardown leaves the deadline null and skips the flush — leftover pending rows
        // replay on the next mount open. Then stop the queue (cancels its retry timer).
        const deadline = getShutdownDrainDeadline();
        if (deadline !== null) {
            await mount.uploadQueue
                .drain({ flushNow: true, deadline })
                .catch((e) => console.error(`[Mount] shutdown drain failed:`, e));
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
    console.log(`[Mount] syncDocumentDbSize ${pathId} size=${size}`);
    await mount.invalidateAncestorsOf(pathId);
}
