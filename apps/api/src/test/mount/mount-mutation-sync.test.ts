import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MountConfig } from '@workspace/lib/types';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import { Mount } from '../../lib/mount/mount';
import { buildStorageKey } from '../../lib/mount/names';
import { setShutdownDrainDeadline } from '../../lib/mount/upload-limits';
import type { FaultStorage } from '../fault-storage-helpers';
import {
    countRowsInFile,
    createFaultMount,
    createGetLocalDatabase,
    pendingUploadCount,
} from '../fault-storage-helpers';
import { createTestMountConfig } from '../mount-test-helpers';

// A cached document DB must sync to its current storage key after a move, rename, trash or delete. On the
// `local` backend a key is the hierarchical path, so it changes; s3 and local-key keys are id-stable.

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

// The rows of a document database, read inside one withDatabase call.
async function readItems(mount: Mount, config: DatabaseConfig<typeof docSchema>, dataDbId: string) {
    return mount.withDatabase(config, dataDbId, async (managed) => managed.db.select().from(docSchema.items).all());
}

const createdMounts: Mount[] = [];

async function createMount(id: string, storageType: MountConfig['storageType']): Promise<Mount> {
    const mount = new Mount(
        OWNER_ID,
        TEST_DIR,
        createTestMountConfig(id, storageType),
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
    return countRowsInFile(await mount.readFile(dataDbId), TEST_DIR);
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
        expect(await readItems(mount, docConfig, dataDbId)).toHaveLength(2);
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

        expect(await readItems(mount, docConfig, dataDbId)).toHaveLength(2);
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    });

    test('TRASH of a chat container: its open dirty data.db syncs INTO .trash/, losing nothing', async () => {
        const mount = await createMount('local-chat-trash', 'local');
        const rootId = (await mount.getRootFolder())!.id;
        const chatId = await mount.createFolder(rootId, 'room', 'chat');
        const dataDbId = await mount.touchFile(chatId, 'data.db', 'application/x-sqlite3');

        // Chat data.db is NOT a Yjs collab doc; it stays cached + dirty across the trash directory rename.
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'synced' }).run();
        await managed.flush(); // synced to room/data.db
        managed.db.insert(docSchema.items).values({ id: 2, data: 'dirty' }).run(); // NOT flushed

        await mount.trashPath(chatId); // room -> .trash/<chatId>
        await managed.flush();

        // The sync after the rename resolves the trashed key, so the dirty edit lands in .trash/, never in
        // a resurrected room/data.db outside it.
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
        await mount.uploadQueue?.drain({ flushNow: true });
        expect(await backing.exists(storageKey)).toBe(true); // the object really lives at the probed key
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run(); // open + dirty
        expect(existsSync(mount.getTempPath(dataDbId))).toBe(true);

        await mount.deletePath(containerId);

        // The cached DB was closed: its live temp (and 30s sync timer) are gone, so no later tick can
        // re-stage the dead key.
        expect(existsSync(mount.getTempPath(dataDbId))).toBe(false);
        expect(pendingUploadCount(mount)).toBe(0);

        await mount.uploadQueue?.drain({ flushNow: true });
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
        await mount.uploadQueue?.drain({ flushNow: true });

        expect(await readItems(mount, docConfig, dataDbId)).toHaveLength(2);
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
        await mount.closeDatabase(dataDbId); // the close writes the working copy back

        // Backing file lives under the flat id-stable UUID key, untouched by the move.
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    });
});
