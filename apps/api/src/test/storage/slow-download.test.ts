import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MountConfig, S3Config } from '@workspace/lib/types';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount/mount';
import { extractText } from '../../lib/search/extract-text';
import { consumeStream, STORAGE_TIMEOUT_MS, setStorageTimeoutMs } from '../../lib/storage/deadline';
import { LocalStorage } from '../../lib/storage/local-storage';
import { DEFAULT_RETENTION } from '../../lib/versioning/retention';
import { FakeS3Server } from '../fake-s3-server';
import {
    createGetLocalDatabase,
    createS3MountConfig,
    FaultMount,
    provisionDoc,
    registerFaultMount,
    SETTLE_BOUND_MS,
    SHRUNK_STORAGE_TIMEOUT_MS,
    STALL_BOUND_MS,
    settleContainer,
    settlesWithin,
    waitFor,
} from '../fault-storage-helpers';
import { getTestContext } from '../setup';

// A mount whose real S3Storage talks to a FakeS3Server that stalls, fails or cuts its reads.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-slow-download-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'slow-download-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

// A closed, fully acked container whose data.db holds `rows` rows, so the next open has to GET it.
async function storedDoc(mount: Mount, rows = 1): Promise<{ containerId: string; dataDbId: string; dataKey: string }> {
    const doc = await provisionDoc(mount);
    const managed = await mount.createDatabase(docConfig, doc.dataDbId);
    for (let id = 1; id <= rows; id++)
        managed.db
            .insert(docSchema.items)
            .values({ id, data: 'x'.repeat(512) })
            .run();
    await settleContainer(mount, doc.containerId);
    return { ...doc, dataKey: await mount.getStorageKey(doc.dataDbId) };
}

// A plain file already in the bucket, big enough that a stall-body GET holds after its first half.
async function storedFile(name: string): Promise<{ fileId: string; key: string }> {
    const rootId = (await mount.getRootFolder())!.id;
    const bytes = new Uint8Array(256 * 1024).fill(7);
    const fileId = await mount.createFile(rootId, name, 'application/octet-stream', bytes.length, bytes);
    return { fileId, key: await mount.getStorageKey(fileId) };
}

let fake: FakeS3Server;
let s3Config: S3Config;
let mountConfig: MountConfig;
let mount: Mount;

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
beforeEach(async () => {
    const id = `slow-${Math.random().toString(36).slice(2)}`;
    fake = new FakeS3Server(new LocalStorage(join(TEST_DIR, `bucket-${id}`)));
    s3Config = await fake.start();
    mountConfig = { ...createS3MountConfig(id), s3Config };
    mount = new FaultMount(OWNER_ID, TEST_DIR, mountConfig, createGetLocalDatabase(TEST_DIR));
    await mount.init();
});
afterEach(async () => {
    setStorageTimeoutMs(STORAGE_TIMEOUT_MS);
    fake.heal();
    await mount.closeAllDatabases();
    await fake.stop();
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('Stalled S3 reads', () => {
    test('a download whose HEAD stalls answers 503 instead of waiting on the backend', async () => {
        setStorageTimeoutMs(SHRUNK_STORAGE_TIMEOUT_MS);
        const rootId = (await mount.getRootFolder())!.id;
        const fileId = await mount.createFile(rootId, 'a.bin', 'application/octet-stream', 4, new Uint8Array(4));
        fake.faults.set(await mount.getStorageKey(fileId), 'stall');
        const failure = mount.readFile(fileId).catch((error: unknown) => error);
        expect(await settlesWithin([failure], STALL_BOUND_MS)).toBe(true);
        expect(await failure).toMatchObject({ status: 503 });
    });

    test('a document open whose data.db GET stalls mid-body answers 503', async () => {
        setStorageTimeoutMs(SHRUNK_STORAGE_TIMEOUT_MS);
        const { dataDbId, dataKey } = await storedDoc(mount);
        fake.faults.set(dataKey, 'stall-body');
        const failure = mount.openDatabase(docConfig, dataDbId).catch((error: unknown) => error);
        expect(await settlesWithin([failure], STALL_BOUND_MS)).toBe(true);
        expect(await failure).toMatchObject({ status: 503 });
    });

    // The snapshot holds the lock across its GET, so the storage deadline is what bounds the wait.
    test('the container lock frees while a version snapshot waits on its S3 GET', async () => {
        setStorageTimeoutMs(SHRUNK_STORAGE_TIMEOUT_MS);
        const { containerId, dataKey } = await storedDoc(mount);
        fake.faults.set(dataKey, 'stall-body');
        const snapshot = mount.snapshotContainerDataDb(containerId, DEFAULT_RETENTION);
        snapshot.catch(() => {});
        await waitFor(() => fake.heldCount > 0);
        const next = mount.withPathLock(containerId, async () => 'free');
        try {
            expect(await settlesWithin([next], STALL_BOUND_MS)).toBe(true);
        } finally {
            fake.heal();
            await snapshot.catch(() => {});
            await next;
        }
    });

    test('a data.db GET in progress leaves the live working copy unwritten', async () => {
        const { dataDbId, dataKey } = await storedDoc(mount, 64);
        const before = new Set(readdirSync(mount.tmpDir));
        fake.faults.set(dataKey, 'stall-body');
        const open = mount.openDatabase(docConfig, dataDbId);
        try {
            // The first half of the body is on disk, wherever the download writes it.
            await waitFor(() =>
                readdirSync(mount.tmpDir).some(
                    (name) => !before.has(name) && Bun.file(join(mount.tmpDir, name)).size > 0,
                ),
            );
            expect(existsSync(mount.getTempPath(dataDbId))).toBe(false);
        } finally {
            fake.heal();
            await open;
        }
    });
});

describe('Whole-body reads', () => {
    test('a whole-body read whose GET stalls mid-body answers 503', async () => {
        setStorageTimeoutMs(SHRUNK_STORAGE_TIMEOUT_MS);
        const { fileId, key } = await storedFile('e.bin');
        fake.faults.set(key, 'stall-body');
        const failure = mount.readBytes(fileId).catch((error: unknown) => error);
        expect(await settlesWithin([failure], STALL_BOUND_MS)).toBe(true);
        expect(await failure).toMatchObject({ status: 503 });
    });

    test('a whole-body read whose GET fails answers 503, not the raw S3 error', async () => {
        const { fileId, key } = await storedFile('f.bin');
        fake.faults.set(key, 'fail-get');
        await expect(mount.readBytes(fileId)).rejects.toMatchObject({ status: 503 });
    });

    test('a chunk handler that fails surfaces its own error, not a 503', async () => {
        const local = new Error('ENOSPC');
        const failing = consumeStream(
            new Blob(['x']).stream(),
            () => {
                throw local;
            },
            { idleMs: 1_000 },
        );
        await expect(failing).rejects.toBe(local);
    });

    test('mount teardown does not wait on a text extraction whose GET stalls', async () => {
        setStorageTimeoutMs(3_000);
        const rootId = (await mount.getRootFolder())!.id;
        const fileId = await mount.createFile(rootId, 'notes.txt', 'text/plain', 5, new TextEncoder().encode('notes'));
        fake.faults.set(await mount.getStorageKey(fileId), 'stall-body');
        // The same mount restarted with an extractor: its reindex queue replays the dirty row at init.
        await mount.closeAllDatabases();
        mount = new FaultMount(OWNER_ID, TEST_DIR, mountConfig, createGetLocalDatabase(TEST_DIR), extractText);
        await mount.init();
        await waitFor(() => fake.heldCount > 0);
        expect(await settlesWithin([mount.closeAllDatabases()], SETTLE_BOUND_MS)).toBe(true);
    });
});

describe('S3 reads that fail', () => {
    test('a download whose HEAD fails answers 503', async () => {
        const rootId = (await mount.getRootFolder())!.id;
        const fileId = await mount.createFile(rootId, 'b.bin', 'application/octet-stream', 4, new Uint8Array(4));
        fake.faults.set(await mount.getStorageKey(fileId), 'fail');
        await expect(mount.readFile(fileId)).rejects.toMatchObject({ status: 503 });
    });

    test('a copy whose source GET dies midway leaves nothing in tmp/', async () => {
        const rootId = (await mount.getRootFolder())!.id;
        const bytes = new Uint8Array(256 * 1024).fill(7);
        const fileId = await mount.createFile(rootId, 'c.bin', 'application/octet-stream', bytes.length, bytes);
        const before = readdirSync(mount.tmpDir);
        fake.faults.set(await mount.getStorageKey(fileId), 'cut');
        await expect(mount.copyPath(fileId, rootId, 'c copy.bin')).rejects.toThrow();
        expect(readdirSync(mount.tmpDir)).toEqual(before);
    });
});

describe('Abandoned downloads', () => {
    test('a client that abandons a streaming download closes the upstream GET', async () => {
        const rootId = (await mount.getRootFolder())!.id;
        const bytes = new Uint8Array(256 * 1024).fill(7);
        const fileId = await mount.createFile(rootId, 'd.bin', 'application/octet-stream', bytes.length, bytes);
        fake.faults.set(await mount.getStorageKey(fileId), 'stall-body');
        const reader = (await mount.readFile(fileId))!.stream().getReader();
        expect((await reader.read()).done).toBe(false);
        await reader.cancel();
        await waitFor(() => fake.abandoned === 1);
    });
});

describe('A stalled GET and the Home', () => {
    test("the owner's next request gets a Home while the idle one waits on a stalled document GET", async () => {
        const ctx = await getTestContext();
        const ownerId = ctx.alice.user.id;
        const home = await getHome(ownerId);
        const homeMount = new FaultMount(
            ownerId,
            home.homeDir,
            { ...createS3MountConfig('slow-home'), s3Config },
            home.getLocalDatabase.bind(home),
        );
        await homeMount.init();
        registerFaultMount(home.drive, homeMount);
        const rootId = (await homeMount.getRootFolder())!.id;
        const doc = await home.drive.create(homeMount.id, rootId, 'Stalled', 'doc', home.user);
        await settleContainer(homeMount, doc.id);
        const dataDb = (await homeMount.getChildByName(doc.id, 'data.db'))!;

        fake.faults.set(await homeMount.getStorageKey(dataDb.id), 'stall-body');
        const open = home.drive.getCollabDocument(homeMount.id, doc.id);
        open.catch(() => {});
        await waitFor(() => fake.heldCount > 0);
        const shutdown = home.shutdown();
        const next = getHome(ownerId);
        next.catch(() => {});
        try {
            // A whole Home tears down and inits here, so the bound is looser than one storage call's; the wedge outlasts it.
            expect(await settlesWithin([next], 20 * STALL_BOUND_MS)).toBe(true);
            expect(await next).not.toBe(home);
        } finally {
            fake.heal();
            await shutdown;
            await open.catch(() => {});
            await next;
        }
    });
});
