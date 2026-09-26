import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import type { Mount } from '../../lib/mount/mount';
import { UPLOAD_PUT_TIMEOUT_MS } from '../../lib/mount/upload-queue';
import { setShutdownDrainDeadline } from '../../lib/sync';
import {
    countBackingRows,
    createFaultMount,
    type FaultStorage,
    provisionDoc,
    SETTLE_BOUND_MS,
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

function createS3Mount(id: string, bucket?: string): { mount: Mount; fault: FaultStorage } {
    const { mount, fault } = createFaultMount(OWNER_ID, TEST_DIR, id, bucket);
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
    test('the shutdown flush returns by its deadline while a PUT is stalled', async () => {
        const { mount, fault } = createS3Mount('shutdown-stalled-put');
        await mount.init();
        const { dataDbId, managed } = await openSettledDoc(mount);

        fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        await fault.waitForParked(() => true);

        setShutdownDrainDeadline(Date.now() + 50);
        const closing = mount.closeAllDatabases();
        try {
            expect(await settlesWithin([closing], SETTLE_BOUND_MS)).toBe(true);
        } finally {
            await fault.landAllRemaining();
            await closing;
        }
    });

    test('the shutdown flush returns by its deadline while the destination semaphore is held', async () => {
        const bucket = `shared-${Date.now()}`;
        const { mount, fault } = createS3Mount('semaphore-waiter', bucket);
        await mount.init();
        const { dataDbId, managed } = await openSettledDoc(mount);

        // Four other mounts on the same bucket each hold a semaphore slot with a stalled PUT.
        const holders: FaultStorage[] = [];
        for (let i = 0; i < 4; i++) {
            const holder = createS3Mount(`semaphore-holder-${i}`, bucket);
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

        setShutdownDrainDeadline(Date.now() + 50);
        const closing = mount.closeAllDatabases();
        try {
            expect(await settlesWithin([closing], SETTLE_BOUND_MS)).toBe(true);
        } finally {
            for (const holder of holders) await holder.landAllRemaining();
            await closing;
        }
        // No PUT may start once the deadline has passed.
        expect(fault.writeCount).toBe(writesBefore);
    });
});

describe('edits while a PUT is stalled', () => {
    // Four syncs of one doc behind its first, parked PUT; land() lets that PUT through and drains the rest.
    async function editBehindParkedPut(id: string) {
        const { mount, fault } = createS3Mount(id);
        await mount.init();
        const { dataDbId, managed } = await openSettledDoc(mount);
        const writesBefore = fault.writeCount;
        fault.parkWrites = true;
        for (let row = 1; row <= 4; row++) {
            managed.db.insert(docSchema.items).values({ id: row, data: 'x' }).run();
            await managed.flush();
            await fault.waitForParked(() => true);
        }
        const land = async () => {
            fault.parkWrites = false;
            await fault.releaseOldestParked();
            await mount.drainPendingUploads({ flushNow: true });
        };
        return { mount, dataDbId, putsStarted: () => fault.writeCount - writesBefore, land };
    }

    test('later syncs coalesce into one pending row behind the stalled PUT; no parallel PUT starts', async () => {
        const { mount, dataDbId, putsStarted, land } = await editBehindParkedPut('stalled-coalesce');
        expect(putsStarted()).toBe(1);
        expect(mount.pendingUploadCount).toBe(1);

        await land();
        expect(mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(mount, dataDbId, TEST_DIR)).toBe(4);
    });

    test('staged copies superseded behind a stalled PUT are removed', async () => {
        const { mount, land } = await editBehindParkedPut('stalled-supersede-leak');
        // The in-flight copy and the newest one; the two between were superseded.
        expect(readdirSync(mount.stagingDir)).toHaveLength(2);

        await land();
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
