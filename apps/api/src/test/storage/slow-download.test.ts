import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { S3Config } from '@workspace/lib/types';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount/mount';
import { LocalStorage } from '../../lib/storage/local-storage';
import { DEFAULT_RETENTION } from '../../lib/versioning/retention';
import { FakeS3Server } from '../fake-s3-server';
import {
    countRowsInFile,
    createGetLocalDatabase,
    createS3MountConfig,
    FaultMount,
    provisionDoc,
    registerFaultMount,
    settleContainer,
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

// Settles as `op` does, or rejects once `ms` pass with it still pending: the bound the code under test lacks.
async function within<T>(op: Promise<T>, ms = 1_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
    });
    try {
        return await Promise.race([op, bound]);
    } finally {
        clearTimeout(timer);
    }
}

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

let fake: FakeS3Server;
let s3Config: S3Config;
let mount: Mount;

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
beforeEach(async () => {
    const id = `slow-${Math.random().toString(36).slice(2)}`;
    fake = new FakeS3Server(new LocalStorage(join(TEST_DIR, `bucket-${id}`)));
    s3Config = await fake.start();
    mount = new FaultMount(
        OWNER_ID,
        TEST_DIR,
        { ...createS3MountConfig(id), s3Config },
        createGetLocalDatabase(TEST_DIR),
    );
    await mount.init();
});
afterEach(async () => {
    fake.heal();
    await mount.closeAllDatabases();
    await fake.stop();
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('Stalled S3 reads', () => {
    // Gap DL-1: an S3 HEAD or GET that never answers holds its caller until Bun's ~6 min client timeout.
    test.failing('a download whose HEAD stalls answers 503 instead of waiting on the backend', async () => {
        const rootId = (await mount.getRootFolder())!.id;
        const fileId = await mount.createFile(rootId, 'a.bin', 'application/octet-stream', 4, new Uint8Array(4));
        fake.faults.set(await mount.getStorageKey(fileId), 'stall');
        await expect(within(mount.readFile(fileId))).rejects.toMatchObject({ status: 503 });
    });

    // Gap DL-1: an S3 HEAD or GET that never answers holds its caller until Bun's ~6 min client timeout.
    test.failing('a document open whose data.db GET stalls mid-body answers 503', async () => {
        const { dataDbId, dataKey } = await storedDoc(mount);
        fake.faults.set(dataKey, 'stall-body');
        await expect(within(mount.openDatabase(docConfig, dataDbId))).rejects.toMatchObject({ status: 503 });
    });

    // Gap DL-2: mount teardown awaits a document open parked in its GET, so a stalled GET wedges the Home's shutdown.
    test.failing('mount teardown finishes while a document open waits on its data.db GET', async () => {
        const { dataDbId, dataKey } = await storedDoc(mount);
        fake.faults.set(dataKey, 'stall-body');
        const open = mount.openDatabase(docConfig, dataDbId);
        open.catch(() => {});
        await waitFor(() => fake.heldCount > 0);
        const teardown = mount.closeAllDatabases();
        teardown.catch(() => {});
        try {
            await within(teardown);
        } finally {
            fake.heal();
            await teardown;
            await open.catch(() => {});
        }
    });

    // Gap DL-3: a version snapshot holds the container lock across its S3 GET.
    test.failing('the container lock frees while a version snapshot waits on its S3 GET', async () => {
        const { containerId, dataKey } = await storedDoc(mount);
        fake.faults.set(dataKey, 'stall-body');
        const snapshot = mount.snapshotContainerDataDb(containerId, DEFAULT_RETENTION);
        snapshot.catch(() => {});
        await waitFor(() => fake.heldCount > 0);
        const next = mount.withPathLock(containerId, async () => 'free');
        next.catch(() => {});
        try {
            expect(await within(next)).toBe('free');
        } finally {
            fake.heal();
            await snapshot.catch(() => {});
            await next;
        }
    });
});

describe('S3 reads that fail', () => {
    // Gap DL-4: a failed S3 read surfaces as a raw S3Error (HTTP 500, collab close 1008), not the 503 of an unreachable backend.
    test.failing('a download whose HEAD fails answers 503', async () => {
        const rootId = (await mount.getRootFolder())!.id;
        const fileId = await mount.createFile(rootId, 'b.bin', 'application/octet-stream', 4, new Uint8Array(4));
        fake.faults.set(await mount.getStorageKey(fileId), 'fail');
        await expect(within(mount.readFile(fileId), 4_000)).rejects.toMatchObject({ status: 503 });
    });

    // Gap DL-4: a failed S3 read surfaces as a raw S3Error (HTTP 500, collab close 1008), not the 503 of an unreachable backend.
    test.failing('a document open whose data.db GET dies midway answers 503', async () => {
        const { dataDbId, dataKey } = await storedDoc(mount);
        fake.faults.set(dataKey, 'cut');
        await expect(within(mount.openDatabase(docConfig, dataDbId))).rejects.toMatchObject({ status: 503 });
    });

    test('a data.db GET that dies midway leaves no working copy, and the next open reads the whole object', async () => {
        const { dataDbId, dataKey } = await storedDoc(mount, 64);
        fake.faults.set(dataKey, 'cut');
        await expect(within(mount.openDatabase(docConfig, dataDbId))).rejects.toThrow();
        expect(readdirSync(mount.tmpDir).filter((name) => name.startsWith(dataDbId))).toEqual([]);

        fake.heal();
        await mount.openDatabase(docConfig, dataDbId);
        await mount.closeDatabase(dataDbId);
        expect(await countRowsInFile(mount.storage.read(await mount.getStorageKey(dataDbId)), TEST_DIR)).toBe(64);
    });

    // Gap DL-6: a process death mid-GET leaves a truncated working copy that every later open adopts and fails on.
    test.failing('a working copy truncated by a process death mid-GET is re-fetched on the next open', async () => {
        const { dataDbId } = await storedDoc(mount, 64);
        const stored = await mount.storage.read(await mount.getStorageKey(dataDbId)).bytes();
        await Bun.write(mount.getTempPath(dataDbId), stored.subarray(0, Math.floor(stored.length * 0.6)));
        const managed = await mount.openDatabase(docConfig, dataDbId);
        expect(managed.db.select().from(docSchema.items).all()).toHaveLength(64);
    });

    // Gap DL-5: a copy whose source GET dies midway leaves its partial temp in tmp/ until the next mount open.
    test.failing('a copy whose source GET dies midway leaves nothing in tmp/', async () => {
        const rootId = (await mount.getRootFolder())!.id;
        const bytes = new Uint8Array(256 * 1024).fill(7);
        const fileId = await mount.createFile(rootId, 'c.bin', 'application/octet-stream', bytes.length, bytes);
        const before = readdirSync(mount.tmpDir);
        fake.faults.set(await mount.getStorageKey(fileId), 'cut');
        await expect(within(mount.copyPath(fileId, rootId, 'c copy.bin'))).rejects.toThrow();
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
    // Gap DL-2: mount teardown awaits a document open parked in its GET, so a stalled GET wedges the Home's shutdown.
    test.failing("the owner's next request gets a Home while the idle one waits on a stalled document GET", async () => {
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
            expect(await within(next)).not.toBe(home);
        } finally {
            fake.heal();
            await shutdown;
            await open.catch(() => {});
            await next;
        }
    });
});
