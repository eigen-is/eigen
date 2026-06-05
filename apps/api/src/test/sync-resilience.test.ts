import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import { createDefaultMountConfig, Mount } from '../lib/mount/mount';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-sync-resilience-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

function createGetLocalDatabase(baseDir: string) {
    return async <S extends SchemaType>(
        config: DatabaseConfig<S>,
        relativePath: string,
    ): Promise<ManagedDatabase<S>> => {
        const db = new ManagedDatabase(config, join(baseDir, relativePath));
        await db.open(0);
        return db;
    };
}

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'sync-test-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

async function countBackingRows(mount: Mount, dataDbId: string): Promise<number> {
    // Read the backing-store bytes and open them as a standalone DB. Avoids relying on
    // BunFile.name and never opens a second connection to a live temp file.
    const bytes = await (await mount.readFile(dataDbId))!.arrayBuffer();
    const verifyPath = join(TEST_DIR, `verify-${Math.random().toString(36).slice(2)}.db`);
    await Bun.write(verifyPath, bytes);
    // Not readonly: the copied main file is WAL-mode, and readonly opens can't create the
    // -shm sidecar (SQLITE_CANTOPEN). A throwaway read-write open is fine.
    const verify = new Database(verifyPath);
    const row = verify.query('SELECT COUNT(*) as c FROM items').get() as { c: number };
    verify.close();
    return row.c;
}

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

describe('Phase 1a — crash-recovery durability (Gap 1)', () => {
    test('a temp surviving an unclean shutdown re-syncs its unsynced bytes on the next open+close', async () => {
        const mount = new Mount(
            OWNER_ID,
            TEST_DIR,
            createDefaultMountConfig('crash-recovery', 'local'),
            createGetLocalDatabase(TEST_DIR),
        );
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;

        const containerId = await mount.createFolder(rootId, 'DocContainer', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');

        // Provision + one synced row, then a clean close: backing store has {1}, temp gone.
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'synced' }).run();
        await mount.closeDatabase(dataDbId);
        expect(await countBackingRows(mount, dataDbId)).toBe(1);

        // Simulate a crash: rebuild the temp from the backing store, add an UNSYNCED row,
        // and leave it behind exactly as an unclean shutdown would (no clean close ran).
        const tempPath = mount.getTempPath(dataDbId);
        await Bun.write(tempPath, await (await mount.readFile(dataDbId))!.arrayBuffer());
        const crashTemp = new Database(tempPath);
        crashTemp.run('PRAGMA journal_mode = WAL;');
        crashTemp.run("INSERT INTO items (id, data) VALUES (2, 'unsynced')");
        crashTemp.run('PRAGMA wal_checkpoint(TRUNCATE);');
        crashTemp.close();
        for (const j of [`${tempPath}-wal`, `${tempPath}-shm`]) {
            if (existsSync(j)) unlinkSync(j);
        }

        // Reopen (sees the surviving temp → recovers) and close WITHOUT any new write.
        await mount.openDatabase(docConfig, dataDbId);
        await mount.closeDatabase(dataDbId);

        // The unsynced row must have reached the backing store. Without Phase 1a's
        // markDirty(), the reopened DB looked clean and cleanupTemp dropped row 2.
        expect(await countBackingRows(mount, dataDbId)).toBe(2);
    });
});
