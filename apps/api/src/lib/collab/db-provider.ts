// Saves one open collab document to its data.db. Every Yjs update becomes a row as it happens, and
// from time to time the rows fold into one snapshot of the whole state, so data.db stays small and
// loads fast. A CollabDocument makes one when it opens and destroys it when it closes, which writes a
// last snapshot.

import { desc, lt, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as Y from 'yjs';
import type { ManagedDatabase } from '../core';
import { compressBlob } from './blob-codec';
import * as schema from './schema';
import { loadYjsState } from './yjs-loader';

// The stored updates fold into one snapshot after 100 of them or after 1 MB. A sheet writes its whole
// workbook as one update when a tab closes, so counting alone would let data.db grow to about 100 times
// the document before it folds. With the byte limit too, data.db stays near twice the document.
const SNAPSHOT_INTERVAL = 100;
const SNAPSHOT_BYTES = 1_000_000;

export class DbProvider {
    private readonly db: BunSQLiteDatabase<typeof schema>;
    private readonly doc: Y.Doc;
    private readonly label: string;
    private updatesSinceSnapshot: number;
    private bytesSinceSnapshot: number;

    public constructor(doc: Y.Doc, label: string, managedDb: ManagedDatabase<typeof schema>) {
        this.db = managedDb.db;
        this.doc = doc;
        this.label = label;

        // The stored state loads before the provider listens, so loading saves nothing.
        const { updatesApplied, bytesApplied } = loadYjsState(managedDb, doc, label);
        this.updatesSinceSnapshot = updatesApplied;
        this.bytesSinceSnapshot = bytesApplied;
        doc.on('update', this.storeUpdate);
    }

    public destroy(): void {
        this.doc.off('update', this.storeUpdate);
        this.createSnapshot();
    }

    private readonly storeUpdate = (update: Uint8Array): void => {
        try {
            this.db
                .insert(schema.docUpdates)
                .values({ updateData: compressBlob(update) })
                .run();
            this.updatesSinceSnapshot++;
            this.bytesSinceSnapshot += update.byteLength;

            if (this.updatesSinceSnapshot >= SNAPSHOT_INTERVAL || this.bytesSinceSnapshot >= SNAPSHOT_BYTES) {
                this.createSnapshot();
            }
        } catch (error) {
            // Never rethrow. An 'update' handler runs inside the cleanup of a Yjs transaction, and a throw
            // there leaves that cleanup unfinished. Every later update on the document would then be
            // neither saved nor broadcast. The next snapshot fills the gap, because it holds the whole state.
            console.error(`[DbProvider] Error storing update for ${this.label}:`, error);
        }
    };

    private createSnapshot(): void {
        try {
            const stateData = compressBlob(Y.encodeStateAsUpdate(this.doc));

            this.db.transaction((tx) => {
                const lastUpdate = tx
                    .select({ id: schema.docUpdates.id })
                    .from(schema.docUpdates)
                    .orderBy(desc(schema.docUpdates.id))
                    .limit(1)
                    .get();
                if (!lastUpdate) return;

                const snapshot = tx
                    .insert(schema.docSnapshots)
                    .values({ stateData, lastUpdateId: lastUpdate.id })
                    .returning({ id: schema.docSnapshots.id })
                    .get();
                tx.delete(schema.docUpdates).where(lte(schema.docUpdates.id, lastUpdate.id)).run();
                // data.db keeps only the newest snapshot, so a load reads one row and the updates after
                // it. The version history lives in the container's versions folder.
                tx.delete(schema.docSnapshots).where(lt(schema.docSnapshots.id, snapshot.id)).run();
            });

            this.updatesSinceSnapshot = 0;
            this.bytesSinceSnapshot = 0;
        } catch (error) {
            // The update rows survive, because they are only deleted inside the transaction. The counters
            // stay as they are, so the next update tries again.
            console.error(`[DbProvider] Error creating snapshot for ${this.label}:`, error);
        }
    }
}
