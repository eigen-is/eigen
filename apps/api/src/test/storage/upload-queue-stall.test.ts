import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import type { Mount } from '../../lib/mount/mount';
import { UPLOAD_PUT_TIMEOUT_MS } from '../../lib/mount/upload-queue';
import { LocalStorage } from '../../lib/storage/local-storage';
import { setShutdownDrainDeadline } from '../../lib/sync';
import {
    countBackingRows,
    createFaultMount,
    createGetLocalDatabase,
    createS3MountConfig,
    FaultMount,
    FaultStorage,
    provisionDoc,
    settlesWithin,
    waitFor,
} from '../fault-storage-helpers';

// Shutdown drain, further edits and direct (non-queued) PUTs while one PUT is parked on the wire.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-upload-queue-stall-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'uq-stall-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

const createdMounts: Mount[] = [];

function createS3Mount(id: string): { mount: Mount; fault: FaultStorage } {
    const { mount, fault } = createFaultMount(OWNER_ID, TEST_DIR, id);
    createdMounts.push(mount);
    return { mount, fault };
}

// Mounts on one bucket share its upload semaphore, as every default mount shares the server's bucket.
function createSharedDestinationMount(id: string, bucket: string): { mount: Mount; fault: FaultStorage } {
    const config = createS3MountConfig(id);
    const shared = { ...config, s3Config: { ...config.s3Config!, bucket } };
    const mount = new FaultMount(OWNER_ID, TEST_DIR, shared, createGetLocalDatabase(TEST_DIR));
    const fault = new FaultStorage(new LocalStorage(join(TEST_DIR, `backing-${id}`)));
    mount.storage = fault;
    createdMounts.push(mount);
    return { mount, fault };
}

// A doc whose create-time schema PUT has acked, so the next parked write is the one under test.
async function openSettledDoc(mount: Mount) {
    const { dataDbId } = await provisionDoc(mount);
    const managed = await mount.createDatabase(docConfig, dataDbId);
    await mount.drainPendingUploads({ flushNow: true });
    return { dataDbId, managed };
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

describe('shutdown drain with a stalled PUT', () => {
    // Gap UP-1: the shutdown flush waits out an in-flight PUT past its deadline.
    test.failing('the shutdown flush returns by its deadline while a PUT is stalled', async () => {
        const { mount, fault } = createS3Mount('shutdown-stalled-put');
        await mount.init();
        const { dataDbId, managed } = await openSettledDoc(mount);

        fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        await fault.waitForParked(() => true);

        setShutdownDrainDeadline(Date.now() + 200);
        const closing = mount.closeAllDatabases();
        try {
            expect(await settlesWithin([closing], 1_500)).toBe(true);
        } finally {
            await fault.landAllRemaining();
            await closing;
        }
    });

    // Gap UP-1: a flush queued behind other mounts' stalled PUTs on the shared semaphore overruns the deadline.
    test.failing('the shutdown flush returns by its deadline while the destination semaphore is held', async () => {
        const bucket = `shared-${Date.now()}`;
        const { mount, fault } = createSharedDestinationMount('semaphore-waiter', bucket);
        await mount.init();
        const { dataDbId, managed } = await openSettledDoc(mount);

        // Four other mounts on the same bucket each hold a semaphore slot with a stalled PUT.
        const holders: FaultStorage[] = [];
        for (let i = 0; i < 4; i++) {
            const holder = createSharedDestinationMount(`semaphore-holder-${i}`, bucket);
            await holder.mount.init();
            const doc = await openSettledDoc(holder.mount);
            holder.fault.parkWrites = true;
            doc.managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
            await holder.mount.closeDatabase(doc.dataDbId);
            await holder.fault.waitForParked(() => true);
            holders.push(holder.fault);
        }

        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        const writesBefore = fault.writeCount;

        setShutdownDrainDeadline(Date.now() + 200);
        const closing = mount.closeAllDatabases();
        try {
            expect(await settlesWithin([closing], 1_500)).toBe(true);
        } finally {
            for (const holder of holders) await holder.landAllRemaining();
            await closing;
        }
        // No PUT may start once the deadline has passed.
        expect(fault.writeCount).toBe(writesBefore);
    });

    test('a PUT stalled past the shutdown deadline keeps its row, and the next boot uploads it', async () => {
        const m1 = createS3Mount('shutdown-then-boot');
        await m1.mount.init();
        const { dataDbId, managed } = await openSettledDoc(m1.mount);

        m1.fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await m1.mount.closeDatabase(dataDbId);
        await m1.fault.waitForParked(() => true);

        const deadline = Date.now() + 50;
        setShutdownDrainDeadline(deadline);
        const closing = m1.mount.closeAllDatabases();
        await waitFor(() => Date.now() > deadline);

        // SIGKILL at the grace period: the dead process never runs its post-PUT bookkeeping.
        m1.mount.uploadQueue?.close();
        setShutdownDrainDeadline(null);
        expect(m1.mount.pendingUploadCount).toBe(1);
        expect(readdirSync(m1.mount.stagingDir)).toHaveLength(1);

        const m2 = createS3Mount('shutdown-then-boot');
        await m2.mount.init();
        await m2.mount.drainPendingUploads({ flushNow: true });
        expect(m2.mount.pendingUploadCount).toBe(0);
        expect(readdirSync(m2.mount.stagingDir)).toHaveLength(0);
        expect(await countBackingRows(m2.mount, dataDbId, TEST_DIR)).toBe(1);

        // The dead process's PUT of the same bytes lands late: idempotent.
        await m1.fault.landAllRemaining();
        await closing;
        expect(await countBackingRows(m2.mount, dataDbId, TEST_DIR)).toBe(1);
    });
});

describe('edits while a PUT is stalled', () => {
    test('later syncs coalesce into one pending row behind the stalled PUT; no parallel PUT starts', async () => {
        const { mount, fault } = createS3Mount('stalled-coalesce');
        await mount.init();
        const { dataDbId, managed } = await openSettledDoc(mount);
        const writesBefore = fault.writeCount;

        fault.parkWrites = true;
        for (let id = 1; id <= 3; id++) {
            managed.db.insert(docSchema.items).values({ id, data: 'x' }).run();
            await managed.flush();
            await fault.waitForParked(() => true);
        }
        expect(fault.writeCount - writesBefore).toBe(1);
        expect(mount.pendingUploadCount).toBe(1);

        fault.parkWrites = false;
        await fault.releaseOldestParked();
        await mount.drainPendingUploads({ flushNow: true });
        expect(mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(mount, dataDbId, TEST_DIR)).toBe(3);
    });

    // Gap UP-5: a sync superseding a copy that is not the in-flight one leaves that copy on disk.
    test.failing('staged copies superseded behind a stalled PUT are removed', async () => {
        const { mount, fault } = createS3Mount('stalled-supersede-leak');
        await mount.init();
        const { managed } = await openSettledDoc(mount);

        fault.parkWrites = true;
        for (let id = 1; id <= 4; id++) {
            managed.db.insert(docSchema.items).values({ id, data: 'x' }).run();
            await managed.flush();
            await fault.waitForParked(() => true);
        }
        // The in-flight copy and the newest one; the two between were superseded.
        expect(readdirSync(mount.stagingDir)).toHaveLength(2);

        fault.parkWrites = false;
        await fault.releaseOldestParked();
        await mount.drainPendingUploads({ flushNow: true });
        expect(readdirSync(mount.stagingDir)).toHaveLength(0);
    });
});

describe('direct (non-queued) PUTs', () => {
    // Gap UP-2: an upload's direct PUT has no ceiling, so a stalled bucket holds the request forever.
    test.failing('a stalled upload PUT settles within the PUT ceiling the queue uses', async () => {
        const { mount, fault } = createS3Mount('direct-upload-stall');
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;
        const tempId = randomUUID();
        writeFileSync(mount.getTempPath(tempId), 'upload');

        fault.parkWrites = true;
        jest.useFakeTimers();
        let settled = false;
        const upload = mount
            .createFileFromTemp(rootId, 'photo.jpg', 'image/jpeg', 6, 'hash', tempId)
            .catch(() => {})
            .finally(() => {
                settled = true;
            });
        try {
            await fault.waitForParked(() => true);
            jest.advanceTimersByTime(UPLOAD_PUT_TIMEOUT_MS + 1);
            jest.useRealTimers();
            await waitFor(() => settled, 200);
        } finally {
            jest.useRealTimers();
            await fault.landAllRemaining();
            await upload;
        }
    });

    // Gap UP-3: an older overwrite PUT landing after a newer one leaves the older bytes.
    test.failing('two overlapping overwrites of one file end on the bytes of the later write', async () => {
        const { mount, fault } = createS3Mount('direct-overwrite-order');
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;
        const fileId = await mount.createFile(rootId, 'notes.md', 'text/markdown', 2, Buffer.from('v0'));
        const key = await mount.getStorageKey(fileId);

        fault.parkWrites = true;
        const first = mount.writeFile(fileId, Buffer.from('v1'));
        await fault.waitForParked((p) => p.key === key);
        const second = mount.writeFile(fileId, Buffer.from('v2'));
        // Tolerates a fix that serializes the second write behind the first.
        await waitFor(() => fault.parkedCount === 2, 300).catch(() => {});

        // Land the newest parked PUT first, as a stalled older request would.
        let settled = false;
        const both = Promise.all([first, second]).finally(() => {
            settled = true;
        });
        while (!settled) {
            const newest = fault.parked.findLast((p) => !p.landed);
            if (newest) await newest.land();
            else await Bun.sleep(5);
        }
        await both;

        expect(await fault.inner.read(key).text()).toBe('v2');
    });

    // Gap UP-4: a permanent delete during an overwrite PUT leaves the deleted bytes in the bucket.
    test.failing('a permanent delete during a stalled overwrite PUT leaves no object behind', async () => {
        const { mount, fault } = createS3Mount('direct-overwrite-delete');
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;
        const fileId = await mount.createFile(rootId, 'secret.txt', 'text/plain', 2, Buffer.from('v0'));
        const key = await mount.getStorageKey(fileId);

        fault.parkWrites = true;
        const write = mount.writeFile(fileId, Buffer.from('v1')).catch(() => {});
        await fault.waitForParked((p) => p.key === key);
        await mount.deletePath(fileId);
        expect(await mount.getPath(fileId)).toBeNull();

        await fault.landAllRemaining();
        await write;
        expect(await fault.inner.exists(key)).toBe(false);
    });
});
