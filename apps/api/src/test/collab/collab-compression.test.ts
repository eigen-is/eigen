import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { compressBlob } from '../../lib/collab/blob-codec';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import { readYjsStateFromFile } from '../../lib/collab/yjs-loader';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// Build a real collab data.db by running the actual migrations, so the test schema stays in
// lockstep with db-config.ts instead of drifting from a hand-rolled DDL copy.
function makeDataDb(): { path: string; db: Database } {
    const path = join(tmpdir(), `collab-test-${crypto.randomUUID()}.db`);
    const db = new Database(path);
    for (const migration of COLLAB_DB_CONFIG.migrations) migration.up(db);
    return { path, db };
}

describe('collab blob compression — read path', () => {
    test('loads a legacy uncompressed snapshot blob (backward compat)', () => {
        const seed = new Y.Doc();
        seed.getMap('state').set('snapshot', 'legacy-content');
        const rawSnapshot = Buffer.from(Y.encodeStateAsUpdate(seed)); // uncompressed, pre-change form
        const { path, db } = makeDataDb();
        db.query('INSERT INTO doc_snapshots (stateData, lastUpdateId) VALUES (?, ?)').run(rawSnapshot, 0);
        db.close();

        const state = readYjsStateFromFile(path);
        rmSync(path, { force: true });
        const out = new Y.Doc();
        Y.applyUpdate(out, state);
        expect(out.getMap('state').get('snapshot')).toBe('legacy-content');
    });

    test('applies a mix of legacy-raw and zstd-compressed update rows', () => {
        const doc = new Y.Doc();
        const updates: Uint8Array[] = [];
        doc.on('update', (u: Uint8Array) => updates.push(u));
        doc.getMap('m').set('a', 1); // small -> stays raw when stored
        doc.getMap('m').set('b', 'z'.repeat(5000)); // large -> compresses
        expect(updates).toHaveLength(2);

        const rawRow = Buffer.from(updates[0]);
        const compressedRow = compressBlob(updates[1]);
        // Sanity: the second row is genuinely a zstd frame.
        expect(compressedRow.subarray(0, 4)).toEqual(ZSTD_MAGIC);

        const { path, db } = makeDataDb();
        const ins = db.query('INSERT INTO doc_updates (updateData) VALUES (?)');
        ins.run(rawRow);
        ins.run(compressedRow);
        db.close();

        const state = readYjsStateFromFile(path);
        rmSync(path, { force: true });
        const out = new Y.Doc();
        Y.applyUpdate(out, state);
        expect(out.getMap('m').get('a')).toBe(1);
        expect(out.getMap('m').get('b')).toBe('z'.repeat(5000));
    });
});
