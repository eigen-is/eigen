// Reads the Yjs state stored in a data.db: the newest snapshot and the updates after it. A live
// document loads through it when it opens, and readers such as the document transforms capture it to
// work off the main thread. readYjsStateFromFile reads a data.db nobody serves, such as a saved version.

import { Database as BunDatabase } from 'bun:sqlite';
import { asc, desc, gt } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as Y from 'yjs';
import { ApiError, isOutOfMemory } from '../core/errors';
import type { ManagedDatabase } from '../core/managed-database';
import { decompressBlob } from './blob-codec';
import * as schema from './schema';

type DocDb = BunSQLiteDatabase<typeof schema>;

// The stored Yjs state, still compressed, copied into buffers of its own. So it can go to the document
// transform process, or be loaded right here on the main thread. The blob ids are only for the logs.
export type YjsStatePayload = {
    snapshot: { id: number; lastUpdateId: number; data: ArrayBuffer } | null;
    updates: { id: number; data: ArrayBuffer }[];
};

function copyBlob(stored: Uint8Array): ArrayBuffer {
    return new Uint8Array(stored).buffer;
}

// Reads the newest snapshot and every update after it, or every update when there is no snapshot. The
// transaction only selects and copies buffers. The decompression and Y.applyUpdate run later in
// materializeYjsState, outside the write path and maybe on another thread.
//
// DbProvider.createSnapshot inserts the snapshot and deletes every update it covers in one transaction.
// So the updates after the newest snapshot are all the updates there are. When the snapshot turns out
// to be corrupt, replaying the captured updates therefore replays every update. The corrupt-snapshot
// test pins it.
function readPayload(db: DocDb): YjsStatePayload {
    let payload: YjsStatePayload = { snapshot: null, updates: [] };
    db.transaction((tx) => {
        const snapshot = tx.select().from(schema.docSnapshots).orderBy(desc(schema.docSnapshots.id)).limit(1).get();
        const updates = snapshot
            ? tx
                  .select()
                  .from(schema.docUpdates)
                  .where(gt(schema.docUpdates.id, snapshot.lastUpdateId))
                  .orderBy(asc(schema.docUpdates.id))
                  .all()
            : tx.select().from(schema.docUpdates).orderBy(asc(schema.docUpdates.id)).all();
        payload = {
            snapshot: snapshot
                ? {
                      id: snapshot.id,
                      lastUpdateId: snapshot.lastUpdateId,
                      data: copyBlob(snapshot.stateData),
                  }
                : null,
            updates: updates.map((update) => ({ id: update.id, data: copyBlob(update.updateData) })),
        };
    });
    return payload;
}

export function readYjsStatePayload(managedDb: ManagedDatabase<typeof schema>): YjsStatePayload {
    return readPayload(managedDb.db);
}

// Decompresses and applies a captured payload into `doc`. Returns counters used
// by DbProvider's snapshot threshold (count + bytes) and the number of corrupt
// blobs skipped. Skipping keeps a live doc best-effort openable; whether a skip
// is tolerable is the caller's decision.
export function materializeYjsState(
    payload: YjsStatePayload,
    doc?: Y.Doc,
    label?: string,
): { doc: Y.Doc; updatesApplied: number; bytesApplied: number; blobsSkipped: number } {
    if (!doc) doc = new Y.Doc();
    let bytesApplied = 0;
    let blobsSkipped = 0;

    if (payload.snapshot) {
        try {
            Y.applyUpdate(doc, decompressBlob(new Uint8Array(payload.snapshot.data)));
        } catch (error) {
            if (isOutOfMemory(error)) throw error;
            blobsSkipped++;
            console.error(`[yjs-loader] Skipping corrupted snapshot${label ? ` for ${label}` : ''}`);
        }
    }

    for (const update of payload.updates) {
        try {
            const data = decompressBlob(new Uint8Array(update.data));
            Y.applyUpdate(doc, data);
            bytesApplied += data.byteLength;
        } catch (error) {
            if (isOutOfMemory(error)) throw error;
            blobsSkipped++;
            console.error(`[yjs-loader] Skipping corrupted update ${update.id}${label ? ` for ${label}` : ''}`);
        }
    }

    return { doc, updatesApplied: payload.updates.length, bytesApplied, blobsSkipped };
}

export function loadYjsState(
    managedDb: ManagedDatabase<typeof schema>,
    doc?: Y.Doc,
    label?: string,
): { doc: Y.Doc; updatesApplied: number; bytesApplied: number } {
    return materializeYjsState(readYjsStatePayload(managedDb), doc, label);
}

// Reads a data.db that nobody serves, such as a saved version or a document's data.db in a backup
// archive, and returns its Yjs state as one update. It opens the SQLite file directly, so the open runs
// no migrations on a copy that must not change. Unlike a live load, a corrupt blob here throws. Skipping
// it would let a restore succeed into a half-empty document.
//
// Nothing writes to the handle, but it opens read-write by default. bun:sqlite sometimes fails to open
// a freshly copied data.db read-only (SQLITE_CANTOPEN), and a version restore hands it just that.
// `readonly` is for the backup verify, which must not touch the databases at all. An open alone can
// leave a journal beside a file whose bytes the verify just hashed.
export function readYjsStateFromFile(localPath: string, options?: { label?: string; readonly?: boolean }): Uint8Array {
    // `{ readonly: false }` is not the same as no options: bun:sqlite then builds flags with neither
    // READONLY nor READWRITE and refuses the open.
    const rawDb = options?.readonly ? new BunDatabase(localPath, { readonly: true }) : new BunDatabase(localPath);
    try {
        const doc = new Y.Doc();
        const { blobsSkipped } = materializeYjsState(readPayload(drizzle(rawDb, { schema })), doc, options?.label);
        if (blobsSkipped > 0) {
            throw new ApiError(422, `Snapshot is corrupted (${blobsSkipped} unreadable Yjs blobs); restore aborted`);
        }
        return Y.encodeStateAsUpdate(doc);
    } finally {
        rawDb.close();
    }
}
