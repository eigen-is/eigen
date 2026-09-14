import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import { Mount } from '../../lib/mount/mount';
import { createFaultMount, createGetLocalDatabase, provisionDoc } from '../fault-storage-helpers';
import { createTestMountConfig } from '../mount-test-helpers';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-document-db-size-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
// No snapshot config: a close-time version enqueue would be noise here.
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'size-test-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

// Closed after each test so no mount's upload-queue retry timer outlives it.
const mounts: Mount[] = [];

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(async () => {
    for (const mount of mounts) {
        try {
            await mount.closeAllDatabases();
        } catch {}
    }
    mounts.length = 0;
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

// Grow the file with rows, then delete them: the live db keeps the freed pages while a
// VACUUM INTO copy drops them, so the two sizes must differ.
function bloatThenEmpty(db: BunSQLiteDatabase<typeof docSchema>): void {
    const padding = 'x'.repeat(400);
    for (let id = 1; id <= 2_000; id++) {
        db.insert(docSchema.items).values({ id, data: padding }).run();
    }
    db.delete(docSchema.items).run();
}

describe('container data.db row size', () => {
    test('a queued mount sizes the row from the uploaded object, not the live working copy', async () => {
        const { mount } = createFaultMount(OWNER_ID, TEST_DIR, 'queued-size');
        mounts.push(mount);
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        const managed = await mount.createDatabase(docConfig, dataDbId);
        bloatThenEmpty(managed.db);
        await managed.flush();

        const liveSize = statSync(mount.getTempPath(dataDbId)).size;
        await mount.drainPendingUploads({ flushNow: true });
        const objectSize = await mount.storage.size(await mount.getStorageKey(dataDbId));
        expect(objectSize).not.toBeNull();
        expect(objectSize!).toBeLessThan(liveSize);

        expect((await mount.getPath(dataDbId))!.size).toBe(objectSize!);

        // Nothing changed since the last sync, so close must leave the row on the object's size.
        await mount.closeDatabase(dataDbId);
        await mount.drainPendingUploads({ flushNow: true });
        expect((await mount.getPath(dataDbId))!.size).toBe(objectSize!);
    });

    test('a local mount still sizes the row from the live working copy', async () => {
        const mount = new Mount(
            OWNER_ID,
            TEST_DIR,
            createTestMountConfig('local-size', 'local'),
            createGetLocalDatabase(TEST_DIR),
        );
        mounts.push(mount);
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        const managed = await mount.createDatabase(docConfig, dataDbId);
        bloatThenEmpty(managed.db);
        await managed.flush();

        const liveSize = statSync(mount.getTempPath(dataDbId)).size;
        expect((await mount.getPath(dataDbId))!.size).toBe(liveSize);
        expect(await mount.storage.size(await mount.getStorageKey(dataDbId))).toBe(liveSize);
    });
});
