import { Database as BunDatabase } from 'bun:sqlite';
import { asc, desc, gt } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import * as Y from 'yjs';
import type { ManagedDatabase, SchemaType } from '../core/managed-database';
import { decompressBlob } from './blob-codec';
import * as schema from './schema';

type DocDb = BunSQLiteDatabase<typeof schema>;

// Reconstructs Yjs state from doc_snapshots + doc_updates into `doc`. The
// SQLite transaction is shared between live (`loadYjsState`) and snapshot-file
// (`readYjsStateFromFile`) reads to avoid two near-identical copies of this.
// Returns counters used by DbProvider's snapshot threshold (count + bytes).
function replayYjsState(db: DocDb, doc: Y.Doc, label?: string): { updatesApplied: number; bytesApplied: number } {
    let updatesApplied = 0;
    let bytesApplied = 0;
    db.transaction((tx) => {
        const snapshot = tx.select().from(schema.docSnapshots).orderBy(desc(schema.docSnapshots.id)).limit(1).get();

        let loadedSnapshot = false;
        if (snapshot) {
            try {
                Y.applyUpdate(doc, decompressBlob(snapshot.stateData as Uint8Array));
                loadedSnapshot = true;
            } catch {
                console.error(`[yjs-loader] Skipping corrupted snapshot${label ? ` for ${label}` : ''}`);
            }
        }

        const updates =
            loadedSnapshot && snapshot
                ? tx
                      .select()
                      .from(schema.docUpdates)
                      .where(gt(schema.docUpdates.id, snapshot.lastUpdateId))
                      .orderBy(asc(schema.docUpdates.id))
                      .all()
                : tx.select().from(schema.docUpdates).orderBy(asc(schema.docUpdates.id)).all();

        for (const update of updates) {
            try {
                const data = decompressBlob(update.updateData as Uint8Array);
                Y.applyUpdate(doc, data);
                bytesApplied += data.byteLength;
            } catch {
                console.error(`[yjs-loader] Skipping corrupted update ${update.id}${label ? ` for ${label}` : ''}`);
            }
        }

        updatesApplied = updates.length;
    });
    return { updatesApplied, bytesApplied };
}

export function loadYjsState(
    managedDb: ManagedDatabase<SchemaType>,
    doc?: Y.Doc,
    label?: string,
): { doc: Y.Doc; updatesApplied: number; bytesApplied: number } {
    if (!doc) doc = new Y.Doc();
    const { updatesApplied, bytesApplied } = replayYjsState(managedDb.db as DocDb, doc, label);
    return { doc, updatesApplied, bytesApplied };
}

// Reads a snapshot data.db file (a versions/<timestamp>.db copy) and returns
// its Yjs state as a single update. Opens the SQLite file directly so we don't
// trigger ManagedDatabase's open-time migrations on an immutable archive copy.
//
// `readonly: true` is intentionally NOT set — bun:sqlite is flaky opening
// freshly-copied data.db files read-only (SQLITE_CANTOPEN). The handle isn't
// written to, so read-write is safe here.
export function readYjsStateFromFile(localPath: string, label?: string): Uint8Array {
    const rawDb = new BunDatabase(localPath);
    try {
        const doc = new Y.Doc();
        replayYjsState(drizzle(rawDb, { schema }), doc, label);
        return Y.encodeStateAsUpdate(doc);
    } finally {
        rawDb.close();
    }
}
