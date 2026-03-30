import { asc, desc, gt } from 'drizzle-orm';
import * as Y from 'yjs';
import type { ManagedDatabase, SchemaType } from '../core/managed-database';
import * as schema from './schema';

export function loadYjsState(managedDb: ManagedDatabase<SchemaType>): Y.Doc {
    const db = managedDb.db;
    const doc = new Y.Doc();

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
    });

    return doc;
}
