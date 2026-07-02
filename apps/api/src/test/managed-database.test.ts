import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

describe('ManagedDatabase open-vs-create intent', () => {
    test('mustExist refuses to create a missing database instead of silently making an empty one', async () => {
        // An "open existing" must honor the caller's knowledge (from metadata.db) that the db
        // exists. Opening an absent working copy with create:true silently produced an empty db —
        // the 2026-06-08 data-loss shape. With mustExist, a missing file throws instead of creating.
        const db = new ManagedDatabase(makeConfig(1000), nextDbPath(), {}, true);
        await expect(db.open(0)).rejects.toThrow();
    });

    test('mustExist refuses an existing-but-empty (0-byte) database', async () => {
        // A 0-byte file is a valid empty SQLite, so { create: false } opens it happily — the exact
        // shape a failed S3 GET leaves. mustExist must reject it rather than serve an empty db.
        const dbPath = nextDbPath();
        writeFileSync(dbPath, '');
        const db = new ManagedDatabase(makeConfig(1000), dbPath, {}, true);
        await expect(db.open(0)).rejects.toThrow();
    });
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

describe('ManagedDatabase dirty tracking', () => {
    test('markDirty() forces the next sync even when nothing changed since the last one', async () => {
        // Phase 1a: crash recovery reuses a temp whose total_changes() reset to 0, so the
        // DB looks clean. markDirty() guarantees the unsynced bytes are re-synced instead
        // of being silently dropped by the close-time cleanupTemp.
        let syncs = 0;
        const db = new ManagedDatabase(makeConfig(1000), nextDbPath(), {
            onSync: async () => {
                syncs++;
            },
        });
        await db.open(0);
        db.db.insert(items).values({ v: 'x' }).run();
        await db.flush();
        expect(syncs).toBe(1);

        // No new writes → not dirty → flush is a no-op.
        await db.flush();
        expect(syncs).toBe(1);

        // markDirty() makes the next flush sync despite an unchanged total_changes().
        db.markDirty();
        await db.flush();
        expect(syncs).toBe(2);

        // The forced sync clears the flag — a subsequent clean flush does nothing.
        await db.flush();
        expect(syncs).toBe(2);

        await db.close({ skipFinalSnapshot: true });
    });

    test('a write landing DURING the sync callback stays dirty and re-syncs (AUDIT 2b)', async () => {
        // onSync freezes the bytes it stages up front (Mount's VACUUM INTO); a write that lands
        // during the callback's later awaits is NOT in that copy. sync() used to set the watermark
        // to total_changes() AFTER the await, so that racing write was counted as synced but never
        // staged — silent tail-loss. It must remain dirty and re-sync on the next tick.
        let syncs = 0;
        const db = new ManagedDatabase(makeConfig(1000), nextDbPath(), {
            onSync: async () => {
                syncs++;
                // Model the concurrent write: it lands after the (notional) staged copy is frozen,
                // so its bytes never reach storage in THIS sync.
                if (syncs === 1) db.db.insert(items).values({ v: 'concurrent' }).run();
            },
        });
        await db.open(0);
        db.db.insert(items).values({ v: 'first' }).run();

        await db.flush();
        expect(syncs).toBe(1);

        // The concurrent write was never staged, so the db is still dirty and this flush re-syncs
        // it. Under the pre-fix watermark (captured after the await) this was a silent no-op.
        await db.flush();
        expect(syncs).toBe(2);

        await db.close({ skipFinalSnapshot: true });
    });
});
