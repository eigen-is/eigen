import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type DatabaseConfig, ManagedDatabase } from '../lib/core';
import { DEFAULT_RETENTION } from '../lib/versioning/retention';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-managed-db-${Date.now()}`);
const items = sqliteTable('items', { id: integer('id').primaryKey({ autoIncrement: true }), v: text('v') });
type Schema = { items: typeof items };

function makeConfig(writesPerSnapshot: number): DatabaseConfig<Schema> {
    return {
        name: 'test-md',
        currentVersion: 1,
        schema: { items },
        migrations: [
            { version: 1, up: (db) => db.run('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)') },
        ],
        snapshot: { policy: DEFAULT_RETENTION, writesPerSnapshot },
    };
}

let counter = 0;
const nextDbPath = () => join(TEST_DIR, `md-${counter++}.db`);

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

describe('ManagedDatabase snapshot lifecycle', () => {
    test('flush() pushes writes to storage but does NOT take a version snapshot', async () => {
        // Regression: flush() used to run the snapshot trigger, so a snapshot
        // callback that itself flushes the cached db (Mount.snapshotContainerDataDb)
        // re-entered and fired a second, preserve-hint-less snapshot.
        let syncs = 0;
        let snapshots = 0;
        const db = new ManagedDatabase(makeConfig(3), nextDbPath(), {
            onSync: async () => {
                syncs++;
            },
            onSnapshot: async () => {
                snapshots++;
            },
        });
        await db.open(0);
        for (let i = 0; i < 10; i++) db.db.insert(items).values({ v: 'x' }).run();

        await db.flush();

        expect(syncs).toBe(1);
        expect(snapshots).toBe(0);
        await db.close({ skipFinalSnapshot: true });
    });

    test('close() awaits the final snapshot instead of firing and forgetting it', async () => {
        // Regression: close() fired onSnapshot fire-and-forget, then immediately
        // checkpoint(TRUNCATE)'d and deleted the journals — the async snapshot
        // copy raced the file teardown.
        let snapshotFinished = false;
        const db = new ManagedDatabase(makeConfig(1000), nextDbPath(), {
            onSync: async () => {},
            onSnapshot: async () => {
                await new Promise((r) => setTimeout(r, 20));
                snapshotFinished = true;
            },
        });
        await db.open(0);
        db.db.insert(items).values({ v: 'x' }).run();

        await db.close();

        expect(snapshotFinished).toBe(true);
    });

    test('periodic tick still snapshots once the write threshold is crossed', async () => {
        let snapshots = 0;
        const db = new ManagedDatabase(makeConfig(3), nextDbPath(), {
            onSync: async () => {},
            onSnapshot: async () => {
                snapshots++;
            },
        });
        await db.open(10);
        for (let i = 0; i < 5; i++) db.db.insert(items).values({ v: 'x' }).run();
        await new Promise((r) => setTimeout(r, 50));

        expect(snapshots).toBeGreaterThanOrEqual(1);
        await db.close({ skipFinalSnapshot: true });
    });
});
