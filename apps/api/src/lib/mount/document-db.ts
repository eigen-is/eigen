// The document databases of a mount, such as a container's data.db and comments.db. Each one is a
// SQLite working copy that is opened from storage, synced back to it and closed, one call at a time per
// path. A reader holds one only while it runs, and the database closes after a few idle minutes without
// holders. Mount is how callers reach it, and closeAllDatabases tears every one down when a Home closes
// or a mount goes away.

import * as fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { settlesWithin } from '../../utils/timing';
import type { DatabaseConfig, SchemaType, SyncCallbacks } from '../core';
import { ApiError, ManagedDatabase } from '../core';
import { isViableRecoveryTemp } from './helpers';
import type { Mount } from './mount';
import { paths } from './schema';
import { markContainerContentDirty } from './search-index';
import { getShutdownDrainDeadline } from './upload-limits';

// A database with no holder stays open for five minutes: a close takes a version and an upload, so
// a chat with a message now and then must not pay that for each, and the reindex must not reopen it.
export const IDLE_CLOSE_MS = 5 * 60_000;
// A close waits this long for the holders to let go. Then it closes anyway and logs, so a holder that
// hangs can't hang a shutdown.
export const HOLDER_WAIT_MS = 5_000;

// One path's place in Mount.documentDbs. The slot goes once no open or close waits and no database is open.
export type DocumentDbSlot = {
    // The open database, or null while one is built or after it closed.
    db: ManagedDatabase<SchemaType> | null;
    // The open or close that runs now. The next one for this path waits for it.
    tail: Promise<void>;
    // The opens and closes that wait or run.
    pending: number;
    // The callers that use db right now, such as a withDatabase reader or an open collab document.
    holders: number;
    // The close armed when the last holder let go.
    idleTimer: ReturnType<typeof setTimeout> | null;
    // Set while a close waits for the holders.
    lastHolderGone: (() => void) | null;
};

// A database a caller holds open, and the call that lets go of it.
export type DatabaseHold<S extends SchemaType> = {
    db: ManagedDatabase<S>;
    release: () => void;
};

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

// Runs fn with the database open, until IDLE_CLOSE_MS after the last holder lets go. A close waits for fn, maybe under
// the container path lock, so fn must never take that lock or call withDatabase for the same pathId.
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

// withDatabase for a holder that outlives one call, such as an open collab document. Whatever closes its database
// closes the document first, so this holder may take the container path lock while it holds.
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
            releaseHold(mount, pathId, slot, db);
        };
        return { db, release };
    });
}

// Every open, create and close of one pathId runs here in call order. Lock order: container path lock → slot → tree
// lock, never the reverse. A chain rather than withPathLock, because `has` must also see queued calls.
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
        // documentDbs holds every schema as ManagedDatabase<SchemaType>. The config that built this
        // entry carries the caller's schema S, so it is put back here.
        return slot.db as ManagedDatabase<S>;
    }
    const db = await buildDocumentDb(mount, config, pathId, mode);
    slot.db = db;
    return db;
}

// The last holder to let go wakes a close that waits for it, or else arms the idle close. A hold on a
// database that a close took away lets go of nothing, because the slot may hold a new one by now.
function releaseHold(mount: Mount, pathId: string, slot: DocumentDbSlot, db: ManagedDatabase<SchemaType>): void {
    if (slot.db !== db || --slot.holders > 0) return;
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
    const tempPath = mount.getTempPath(pathId);

    if (mode === 'create') {
        const storageKey = await mount.getStorageKey(pathId);
        if (await mount.storage.exists(storageKey)) {
            throw new Error(`Mount.createDatabase ${pathId}: storage object ${storageKey} already exists`);
        }
    }

    const snapshot = config.snapshot;
    const onSnapshot: SyncCallbacks['onSnapshot'] = snapshot
        ? async () => {
              const path = await mount.getPath(pathId);
              // A database outside a container, or one whose row is gone, has nothing to snapshot. It answers 'taken',
              // so the watermark moves and the tick doesn't try again every 30 s.
              if (!path?.parentId) return 'taken';
              return mount.trySnapshotContainerDataDb(path.parentId, snapshot.policy);
          }
        : undefined;

    // Set when onOpen adopts a temp that an unclean shutdown left. Those bytes never synced, so the
    // database is marked dirty after the open.
    let recoveredFromCrash = false;

    const managed = new ManagedDatabase(
        config,
        tempPath,
        {
            onOpen: async () => {
                if (mode === 'create') return;
                if (fs.existsSync(tempPath)) {
                    // A surviving temp signals an unclean shutdown. A 0-byte or partial temp (a failed S3 GET)
                    // would upload as an empty doc over the good stored object, so only a real SQLite is adopted.
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
                }
                // The open sends no HEAD: the GET itself answers a gone object (410).
                await mount.downloadToTemp(pathId, pathId);
            },
            // On s3 the sync stages a frozen copy and queues its upload. A local mount copies at once:
            // a local write never answers 503, and a queue would only weaken its durability.
            onSync: () =>
                mount.withTreeShared(async () => {
                    // The key is resolved on every sync, under the tree lock: on `local` a move since the open
                    // would write the old tree back. A deleted document's sync must not bring its key back.
                    const currentKey = await mount.findStorageKey(pathId);
                    if (currentKey === null) return;
                    // The row takes the size of the bytes this sync wrote, which ranges and HEAD are served from.
                    let written = tempPath;
                    if (mount.uploadQueue) {
                        written = mount.uploadQueue.newStagingPath();
                        managed.stageCopy(written);
                        // A VACUUM INTO copy of a managed database, so the queue checks its SQLite
                        // header before the PUT.
                        mount.uploadQueue.enqueueStaged(currentKey, written, true);
                    } else {
                        await mount.uploadFromTemp(currentKey, pathId);
                    }
                    const size = fs.statSync(written).size;
                    await mount.db.update(paths).set({ size, updatedAt: new Date() }).where(eq(paths.id, pathId));
                    await mount.invalidateAncestorsOf(pathId);
                    await markContainerContentDirty(mount, pathId);
                }),
            // After a failed final sync the temp is the only copy of the newest writes. It
            // stays as the crash temp, which the next open adopts and syncs again.
            onClose: async (syncFailed) => {
                if (!syncFailed) await mount.cleanupTemp(pathId);
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

    // The new empty schema goes to storage before this returns. Otherwise a restart before the next 30 s sync
    // makes every later open answer 410.
    if (mode === 'create') {
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
        slot.holders = 0;
    }
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    // Cleared before the close, so a snapshot that reads the slot meanwhile never sees the closing database.
    slot.db = null;
    await db.close(opts);
}

// Syncs and closes every open document database at or below rootId, before a delete takes their rows away.
export async function closeCachedDbsUnder(mount: Mount, rootId: string): Promise<void> {
    for (const id of [rootId, ...mount.collectDescendantIds(rootId)]) {
        if (mount.documentDbs.has(id)) {
            await closeDatabase(mount, id, { skipFinalSnapshot: true });
        }
    }
}

// Closes every document database of the mount and stops its queues, when a Home closes or a mount goes
// away. Nothing on the mount opens again after this.
export async function closeAllDatabases(mount: Mount): Promise<void> {
    // The downloads stop first, so nothing below waits for one. The mount is not used again after this,
    // so the abort is for good.
    mount.downloads.abort();

    // Both end before a database closes: an extract in flight may hold a document database, and a
    // background job writes to metadata.db. Only the reindex has a deadline, because an extract can hang.
    await mount.reindexQueue?.close();
    await mount.backgroundDone();

    mount.closing = true;
    // An open that lands after this gate is refused. The sweep walks the live map, not a copy, so it
    // also visits a slot added while it runs.
    for (const pathId of mount.documentDbs.keys()) {
        try {
            // On s3 the final sync of the close stages the last state and queues its upload. A closing
            // Home refuses the hold a PUT takes, so the row waits for the next open, or the flush below.
            await closeDatabase(mount, pathId);
        } catch (err) {
            console.error(`[Mount] closeAllDatabases close failed for ${pathId}:`, err);
        }
    }

    if (mount.uploadQueue) {
        // At shutdown the queue flushes after the final close-time enqueues, up to the deadline. An eviction, such as
        // for a restore, closes a held Home, and its wait keeps an old PUT from landing over what comes next.
        const deadline = getShutdownDrainDeadline();
        if (deadline !== null) {
            await settlesWithin(
                mount.uploadQueue
                    .drain({ flushNow: true })
                    .catch((e) => console.error(`[Mount] shutdown drain failed:`, e)),
                Math.max(0, deadline - Date.now()),
            );
        }
        await mount.uploadQueue.close(deadline === null ? undefined : Math.max(0, deadline - Date.now()));
    }
}
