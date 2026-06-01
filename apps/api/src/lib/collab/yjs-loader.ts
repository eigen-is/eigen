import { Database as BunDatabase } from 'bun:sqlite';
import { asc, desc, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as Y from 'yjs';
import type { ManagedDatabase, SchemaType } from '../core/managed-database';
import * as schema from './schema';

/**
 * Loads Yjs state from the database into the given doc (or a new one if not
 * provided).  Returns the doc and the number of incremental updates that were
 * applied on top of the latest snapshot.
 */
export function loadYjsState(
    managedDb: ManagedDatabase<SchemaType>,
    doc?: Y.Doc,
    label?: string,
): { doc: Y.Doc; updatesApplied: number } {
    const db = managedDb.db;
    if (!doc) doc = new Y.Doc();
    let updatesApplied = 0;

    db.transaction((tx) => {
        const snapshot = tx.select().from(schema.docSnapshots).orderBy(desc(schema.docSnapshots.id)).limit(1).get();

        let loadedSnapshot = false;
        if (snapshot) {
            try {
                Y.applyUpdate(doc, snapshot.stateData as Uint8Array);
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
                Y.applyUpdate(doc, update.updateData as Uint8Array);
            } catch {
                console.error(`[yjs-loader] Skipping corrupted update ${update.id}${label ? ` for ${label}` : ''}`);
            }
        }

        updatesApplied = updates.length;
    });

    return { doc, updatesApplied };
}

/**
 * Reads a snapshot data.db file (a versions/<timestamp>.db copy) and returns
 * its Yjs state as a single update — what Y.encodeStateAsUpdate(doc) would
 * yield for a Y.Doc reconstructed from the file.
 *
 * Opens the SQLite file directly, read-only, so we don't trigger
 * ManagedDatabase's open-time migrations on what is meant to be an immutable
 * archive copy.
 */
export function readYjsStateFromFile(localPath: string, label?: string): Uint8Array {
    // Open read-write but never write — `readonly: true` here is flaky for
    // freshly-copied data.db files (SQLITE_CANTOPEN). We just need to query.
    const rawDb = new BunDatabase(localPath);
    try {
        const db = drizzle(rawDb, { schema });
        const doc = new Y.Doc();

        db.transaction((tx) => {
            const snapshot = tx.select().from(schema.docSnapshots).orderBy(desc(schema.docSnapshots.id)).limit(1).get();

            let loadedSnapshot = false;
            if (snapshot) {
                try {
                    Y.applyUpdate(doc, snapshot.stateData as Uint8Array);
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
                    Y.applyUpdate(doc, update.updateData as Uint8Array);
                } catch {
                    console.error(`[yjs-loader] Skipping corrupted update ${update.id}${label ? ` for ${label}` : ''}`);
                }
            }
        });

        return Y.encodeStateAsUpdate(doc);
    } finally {
        rawDb.close();
    }
}
