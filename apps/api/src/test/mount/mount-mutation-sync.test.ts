import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MountConfig } from '@workspace/lib/types';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import { buildStorageKey, createDefaultMountConfig } from '../../lib/mount/helpers';
import { Mount } from '../../lib/mount/mount';
import { setShutdownDrainDeadline } from '../../lib/sync';
import { createFaultMount, createGetLocalDatabase, type FaultStorage } from '../fault-storage-helpers';

// Regression net for AUDIT_MOUNT § P1 (finding 2a + siblings): a cached document DB syncs to a
// STALE storage key after move/rename/trash/delete on the `local` backend (keys are the hierarchical
// path there; s3/local-key are id-stable and immune). Each `local` test below FAILS before the fix.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-mount-mutation-sync-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
// No snapshot config: a close-time version enqueue would be noise for these move/rename/trash tests.
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'mutation-sync-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

const createdMounts: Mount[] = [];

async function createMount(id: string, storageType: MountConfig['storageType']): Promise<Mount> {
    const mount = new Mount(
        OWNER_ID,
        TEST_DIR,
        createDefaultMountConfig(id, storageType),
        createGetLocalDatabase(TEST_DIR),
    );
    await mount.init();
    createdMounts.push(mount);
    return mount;
}

function createS3Mount(id: string): { mount: Mount; backing: FaultStorage } {
    const { mount, fault } = createFaultMount(OWNER_ID, TEST_DIR, id);
    createdMounts.push(mount);
    return { mount, backing: fault };
}

// Row count in the on-storage copy of data.db, read through the mount's storage at its CURRENT
// resolved key (getStorageKey). If a sync wrote to a stale key, this reads the pre-mutation object.
async function countStoredRows(mount: Mount, dataDbId: string): Promise<number | null> {
    const file = await mount.readFile(dataDbId);
    if (!file) return null;
    const verifyPath = join(TEST_DIR, `verify-${Math.random().toString(36).slice(2)}.db`);
    await Bun.write(verifyPath, await file.arrayBuffer());
    const verify = new Database(verifyPath);
    const row = verify.query('SELECT COUNT(*) as c FROM items').get() as { c: number };
    verify.close();
    rmSync(verifyPath, { force: true });
    return row.c;
}

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(async () => {
    setShutdownDrainDeadline(null);
    for (const mount of createdMounts) {
        try {
            await mount.closeAllDatabases();
        } catch {}
    }
    createdMounts.length = 0;
});
afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

describe('local: open document DB must not sync to a stale path after a mutation', () => {
    test('MOVE of the container while the doc is open keeps post-move edits (not orphaned at the old path)', async () => {
        const mount = await createMount('local-move', 'local');
        const rootId = (await mount.getRootFolder())!.id;
        const srcId = await mount.createFolder(rootId, 'src');
        const dstId = await mount.createFolder(rootId, 'dst');
        const containerId = await mount.createFolder(srcId, 'doc1', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');

        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'pre-move' }).run();
        await managed.flush(); // synced to src/doc1/data.db

        // User A moves the container while user B keeps editing.
        await mount.updatePath(containerId, { parentId: dstId }); // storage.rename src/doc1 -> dst/doc1

        managed.db.insert(docSchema.items).values({ id: 2, data: 'post-move' }).run();
        await managed.flush(); // stale capture would write this to src/doc1/data.db (a zombie tree)
        await mount.closeDatabase(dataDbId);

        // Reopen resolves the NEW path (dst/doc1/data.db); the post-move edit must be there.
        const reopened = await mount.openDatabase(docConfig, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(2);
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    });

    test('RENAME of an ancestor folder while the doc is open keeps post-rename edits', async () => {
        const mount = await createMount('local-rename', 'local');
        const rootId = (await mount.getRootFolder())!.id;
        const folderId = await mount.createFolder(rootId, 'A');
        const containerId = await mount.createFolder(folderId, 'doc1', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');

        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'pre-rename' }).run();
        await managed.flush(); // synced to A/doc1/data.db

        await mount.updatePath(folderId, { name: 'A2' }); // storage.rename A -> A2

        managed.db.insert(docSchema.items).values({ id: 2, data: 'post-rename' }).run();
        await managed.flush(); // stale capture would write this to A/doc1/data.db
        await mount.closeDatabase(dataDbId);

        const reopened = await mount.openDatabase(docConfig, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(2);
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    });

    test('TRASH of a chat container flushes its open dirty data.db INTO .trash/, losing nothing', async () => {
        const mount = await createMount('local-chat-trash', 'local');
        const rootId = (await mount.getRootFolder())!.id;
        const chatId = await mount.createFolder(rootId, 'room', 'chat');
        const dataDbId = await mount.touchFile(chatId, 'data.db', 'application/x-sqlite3');

        // Chat data.db is NOT a Yjs collab doc, so Drive.closeCollabDocumentsRecursively never closes
        // it; it stays cached + dirty across the trash directory rename.
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'synced' }).run();
        await managed.flush(); // synced to room/data.db
        managed.db.insert(docSchema.items).values({ id: 2, data: 'dirty' }).run(); // NOT flushed

        await mount.trashPath(chatId); // room -> .trash/<chatId>

        // The dirty edit must have been flushed into the trashed location, not stranded in the temp
        // (and never written to a resurrected room/data.db zombie outside .trash/).
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    });
});

describe('delete/trash must evict the cached document DB (no resurrection, no leaked temp/timer)', () => {
    test('deleting a container with an open dirty data.db tears the DB down and never resurrects it (s3)', async () => {
        const { mount, backing } = createS3Mount('s3-delete-evict');
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;
        const containerId = await mount.createFolder(rootId, 'doc1', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
        // Capture the real id-stable key while the row can still resolve it: after deletePath removes
        // the row, getStorageKey falls back to the bare pathId — a key nothing ever wrote.
        const storageKey = buildStorageKey(dataDbId, 'data.db');

        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.drainPendingUploads({ flushNow: true });
        expect(await backing.exists(storageKey)).toBe(true); // the object really lives at the probed key
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run(); // open + dirty
        expect(existsSync(mount.getTempPath(dataDbId))).toBe(true);

        await mount.deletePath(containerId);

        // The cached DB was closed: its live temp (and 30s sync timer) are gone, so no later tick can
        // re-stage the dead key.
        expect(existsSync(mount.getTempPath(dataDbId))).toBe(false);
        expect(mount.pendingUploadCount).toBe(0);

        await mount.drainPendingUploads({ flushNow: true });
        expect(await backing.exists(storageKey)).toBe(false); // never resurrected
    });
});

describe('id-stable backends are unaffected by the fix', () => {
    test('s3: a move while the doc is open keeps post-move edits (key is id-stable, never stranded)', async () => {
        const { mount } = createS3Mount('s3-move');
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;
        const srcId = await mount.createFolder(rootId, 'src');
        const dstId = await mount.createFolder(rootId, 'dst');
        const containerId = await mount.createFolder(srcId, 'doc1', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
        const idStableKey = buildStorageKey(dataDbId, 'data.db');

        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.updatePath(containerId, { parentId: dstId }); // no storage move for s3
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await mount.closeDatabase(dataDbId);
        await mount.drainPendingUploads({ flushNow: true });

        const reopened = await mount.openDatabase(docConfig, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(2);
        // The bytes live under the id-stable key, proving the move never stranded it.
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
        expect(idStableKey).toBe(`${dataDbId}.db`);
    });

    test('local-key: a move while the doc is open keeps post-move edits (flat UUID storage)', async () => {
        const mount = await createMount('local-key-move', 'local-key');
        const rootId = (await mount.getRootFolder())!.id;
        const srcId = await mount.createFolder(rootId, 'src');
        const dstId = await mount.createFolder(rootId, 'dst');
        const containerId = await mount.createFolder(srcId, 'doc1', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');

        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.updatePath(containerId, { parentId: dstId }); // no storage move for local-key
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await mount.closeDatabase(dataDbId); // TRUNCATE checkpoint folds the WAL into the backing file

        // Backing file lives under the flat id-stable UUID key, untouched by the move.
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    });
});
