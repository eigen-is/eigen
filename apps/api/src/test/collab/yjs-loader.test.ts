import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { compressBlob } from '../../lib/collab/blob-codec';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import * as schema from '../../lib/collab/schema';
import {
    loadYjsState,
    materializeYjsState,
    readYjsStateFromFile,
    readYjsStatePayload,
} from '../../lib/collab/yjs-loader';
import { ManagedDatabase } from '../../lib/core';

// Unit tests for the capture/materialize split (proposal Phase 1). The capture
// transaction only SELECTs and copies blobs; materialization decompresses and
// applies them — on the main thread (loadYjsState) or inside a transform Worker.
// The corrupt-snapshot cases pin the update-pruning invariant the capture relies
// on: a snapshot insert deletes every update with id <= lastUpdateId, so
// "updates after the snapshot" and "all updates" are the same set.

const GARBAGE = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

let dbCounter = 0;
// mkdtemp, not a pid-keyed name: pids recycle, and a recycled pid would reopen a leftover data-N.db
// whose rows collide with the fixed-id inserts below.
const testDir = mkdtempSync(join(tmpdir(), 'eigen-yjs-loader-'));

// A data.db shaped exactly like DbProvider leaves it: one snapshot row whose
// lastUpdateId points at the consolidation point, plus tail update rows.
async function makeCollabDb(): Promise<{ managedDb: ManagedDatabase<typeof schema>; localPath: string; doc: Y.Doc }> {
    const localPath = `${testDir}/data-${++dbCounter}.db`;
    const managedDb = new ManagedDatabase(COLLAB_DB_CONFIG, localPath);
    await managedDb.open(0);

    const doc = new Y.Doc();
    const tailUpdates: Uint8Array[] = [];
    doc.transact(() => {
        doc.getMap('state').set('snapshot', JSON.stringify([{ id: 'sheet-1', name: 'Base' }]));
    });
    const snapshotState = Y.encodeStateAsUpdate(doc);

    doc.on('update', (update: Uint8Array) => tailUpdates.push(update));
    doc.transact(() => {
        doc.getArray('ops').push([[{ op: 'replace', path: ['a'], value: 1 }]]);
    });
    doc.transact(() => {
        doc.getArray('ops').push([[{ op: 'replace', path: ['b'], value: 2 }]]);
    });

    const db = managedDb.db;
    db.insert(schema.docSnapshots)
        .values({ id: 1, stateData: compressBlob(snapshotState), lastUpdateId: 4 })
        .run();
    db.insert(schema.docUpdates)
        .values({ id: 5, updateData: compressBlob(tailUpdates[0]) })
        .run();
    db.insert(schema.docUpdates)
        .values({ id: 6, updateData: compressBlob(tailUpdates[1]) })
        .run();

    return { managedDb, localPath, doc };
}

function docState(doc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(doc);
}

describe('readYjsStatePayload', () => {
    test('captures the newest snapshot plus updates after it, as standalone buffers', async () => {
        const { managedDb } = await makeCollabDb();
        const payload = readYjsStatePayload(managedDb);

        expect(payload.snapshot).not.toBeNull();
        expect(payload.snapshot!.lastUpdateId).toBe(4);
        expect(payload.snapshot!.data).toBeInstanceOf(ArrayBuffer);
        expect(payload.updates.map((u) => u.id)).toEqual([5, 6]);
        for (const update of payload.updates) expect(update.data).toBeInstanceOf(ArrayBuffer);

        // Standalone copies: wiping the rows afterwards must not affect the payload.
        managedDb.db.delete(schema.docUpdates).run();
        const { doc } = materializeYjsState(payload);
        expect(doc.getArray('ops').length).toBe(2);
    });

    test('captures all updates when no snapshot exists', async () => {
        const { managedDb } = await makeCollabDb();
        managedDb.db.delete(schema.docSnapshots).run();

        const payload = readYjsStatePayload(managedDb);
        expect(payload.snapshot).toBeNull();
        expect(payload.updates.map((u) => u.id)).toEqual([5, 6]);
    });
});

describe('materializeYjsState', () => {
    test('reconstructs the same doc state as loadYjsState', async () => {
        const { managedDb, doc: source } = await makeCollabDb();

        const direct = loadYjsState(managedDb);
        const {
            doc: viaPayload,
            updatesApplied,
            bytesApplied,
            blobsSkipped,
        } = materializeYjsState(readYjsStatePayload(managedDb));

        expect(docState(viaPayload)).toEqual(docState(direct.doc));
        expect(docState(viaPayload)).toEqual(docState(source));
        expect(updatesApplied).toBe(direct.updatesApplied);
        expect(bytesApplied).toBe(direct.bytesApplied);
        expect(blobsSkipped).toBe(0);
    });

    test('corrupt snapshot: equivalent to the live read thanks to the pruning invariant', async () => {
        const { managedDb } = await makeCollabDb();
        managedDb.db.update(schema.docSnapshots).set({ stateData: GARBAGE }).run();

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            // Live read skips the corrupt snapshot and replays every update row.
            const direct = loadYjsState(managedDb);
            const materialized = materializeYjsState(readYjsStatePayload(managedDb));

            expect(materialized.blobsSkipped).toBe(1);
            expect(docState(materialized.doc)).toEqual(docState(direct.doc));
            // Same-client tail updates depend on the snapshot's clock range, so Yjs
            // parks them as pending structs — the doc reads empty. That IS today's
            // live behavior (asserted equal above); this pins it explicitly.
            expect(materialized.doc.getArray('ops').length).toBe(0);
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('corrupt update: skipped with a warning count, remaining updates still apply', async () => {
        const { managedDb } = await makeCollabDb();
        managedDb.db.update(schema.docUpdates).set({ updateData: GARBAGE }).run();

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const direct = loadYjsState(managedDb);
            const materialized = materializeYjsState(readYjsStatePayload(managedDb));

            expect(materialized.blobsSkipped).toBe(2);
            expect(materialized.updatesApplied).toBe(2);
            expect(docState(materialized.doc)).toEqual(docState(direct.doc));
        } finally {
            errorSpy.mockRestore();
        }
    });
});

describe('readYjsStateFromFile (unchanged fail-loud contract)', () => {
    test('returns the full state for a healthy file', async () => {
        const { managedDb, localPath, doc: source } = await makeCollabDb();
        await managedDb.close();

        const state = readYjsStateFromFile(localPath);
        const restored = new Y.Doc();
        Y.applyUpdate(restored, state);
        expect(docState(restored)).toEqual(docState(source));
    });

    test('throws on a corrupt blob instead of restoring a half-empty doc', async () => {
        const { managedDb, localPath } = await makeCollabDb();
        managedDb.db.update(schema.docSnapshots).set({ stateData: GARBAGE }).run();
        await managedDb.close();

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(() => readYjsStateFromFile(localPath)).toThrow('unreadable Yjs blobs');
        } finally {
            errorSpy.mockRestore();
        }
    });
});
