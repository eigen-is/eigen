import { Database as BunDatabase } from 'bun:sqlite';
import { asc, desc, gt } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import * as Y from 'yjs';
import { ApiError } from '../core/errors';
import type { ManagedDatabase } from '../core/managed-database';
import { decompressBlob } from './blob-codec';
import * as schema from './schema';

type DocDb = BunSQLiteDatabase<typeof schema>;

// Compressed persisted Yjs state, captured as standalone buffers so it can be
// transferred to a document-transform Worker (or materialized right here on the
// main thread). Blob ids ride along for diagnostics only.
export type YjsStatePayload = {
    snapshot: { id: number; lastUpdateId: number; data: ArrayBuffer } | null;
    updates: { id: number; data: ArrayBuffer }[];
};

function copyBlob(stored: Uint8Array): ArrayBuffer {
    return new Uint8Array(stored).buffer;
}

// Selects the newest snapshot plus every update with id > snapshot.lastUpdateId
// (all updates when no snapshot exists). The transaction holds only SELECTs and
// buffer copies — decompression and Y.applyUpdate happen in materializeYjsState,
// off the write path and possibly off-thread.
//
// Pruning invariant this capture relies on: DbProvider.createSnapshot inserts the
// snapshot row and deletes every update with id <= lastUpdateId in the SAME
// transaction (collabDocument.ts). So when a snapshot blob later turns out to be
// corrupt, "the captured updates" and "all updates" are the same set, and
// materializeYjsState replays exactly what the pre-split loader replayed via its
// re-select-everything fallback. Pinned by the corrupt-snapshot equivalence test.
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
        } catch {
            blobsSkipped++;
            console.error(`[yjs-loader] Skipping corrupted snapshot${label ? ` for ${label}` : ''}`);
        }
    }

    for (const update of payload.updates) {
        try {
            const data = decompressBlob(new Uint8Array(update.data));
            Y.applyUpdate(doc, data);
            bytesApplied += data.byteLength;
        } catch {
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

// Reads a snapshot data.db file (a versions/<timestamp>.db copy) and returns
// its Yjs state as a single update. Opens the SQLite file directly so we don't
// trigger ManagedDatabase's open-time migrations on an immutable archive copy.
// Unlike a live load, a corrupt blob here fails loud: silently skipping would
// let a restore "succeed" into a half-empty doc (PROPOSAL_DATA_INTEGRITY seam F).
//
// `readonly: true` is intentionally NOT set — bun:sqlite is flaky opening
// freshly-copied data.db files read-only (SQLITE_CANTOPEN). The handle isn't
// written to, so read-write is safe here.
export function readYjsStateFromFile(localPath: string, label?: string): Uint8Array {
    const rawDb = new BunDatabase(localPath);
    try {
        const doc = new Y.Doc();
        const { blobsSkipped } = materializeYjsState(readPayload(drizzle(rawDb, { schema })), doc, label);
        if (blobsSkipped > 0) {
            throw new ApiError(422, `Snapshot is corrupted (${blobsSkipped} unreadable Yjs blobs); restore aborted`);
        }
        return Y.encodeStateAsUpdate(doc);
    } finally {
        rawDb.close();
    }
}
