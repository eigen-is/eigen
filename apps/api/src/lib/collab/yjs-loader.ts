import { asc, desc, gt } from 'drizzle-orm';
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
                console.error('[yjs-loader] Skipping corrupted snapshot');
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
                console.error(`[yjs-loader] Skipping corrupted update ${update.id}`);
            }
        }

        updatesApplied = updates.length;
    });

    return { doc, updatesApplied };
}
