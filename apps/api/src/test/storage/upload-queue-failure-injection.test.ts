import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import { buildStorageKey } from '../../lib/mount/helpers';
import type { Mount } from '../../lib/mount/mount';
import type { StorageFile } from '../../lib/storage';
import { setShutdownDrainDeadline } from '../../lib/sync';
import { createFaultMount, type FaultStorage } from '../fault-storage-helpers';

// Failure-injection pass over the write-behind upload queue (docs/SYNC.md, upload-queue.ts):
// process death mid-drain, corrupted staged bytes, and the orphaned-PUT class — a PUT that
// stalls past the client-side timeout, is treated as failed, and then COMPLETES server-side
// after a newer PUT for the same key already landed. Pins the orphan-tracking repair
// (trackOrphan) and the staged-copy integrity check. Sibling of sync-resilience.test.ts.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-uq-failure-injection-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
// No snapshot config — a close-time version enqueue would just be noise here.
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'uq-chaos-doc',
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

function shrinkPutTimeout(mount: Mount, ms: number): void {
    (mount.uploadQueue as unknown as { putTimeoutMs: number }).putTimeoutMs = ms;
}

async function countRowsInFile(file: StorageFile | null): Promise<number | null> {
    if (!file || !(await file.exists())) return null;
    const verifyPath = join(TEST_DIR, `verify-${Math.random().toString(36).slice(2)}.db`);
    await Bun.write(verifyPath, await file.arrayBuffer());
    const verify = new Database(verifyPath);
    const row = verify.query('SELECT COUNT(*) as c FROM items').get() as { c: number };
    verify.close();
    return row.c;
}

// Rows in the object that actually reached the backing store — deliberately NOT mount.readFile,
// which is freshest-first and would mask a regressed stored object behind staged bytes.
async function countBackingRows(mount: Mount, id: string): Promise<number | null> {
    return countRowsInFile(mount.storage.read(await mount.getStorageKey(id)));
}

async function provisionDoc(mount: Mount): Promise<{ containerId: string; dataDbId: string }> {
    const rootId = (await mount.getRootFolder())!.id;
    const containerId = await mount.createFolder(rootId, `doc-${Math.random().toString(36).slice(2)}`, 'doc');
    const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
    return { containerId, dataDbId };
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await cond())) {
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await Bun.sleep(10);
    }
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

describe('process death mid-drain', () => {
    test('death while a PUT is in flight: replay converges; the late orphan of the same bytes is harmless', async () => {
        const m1 = createS3Mount('death-mid-put');
        await m1.mount.init();
        const { dataDbId } = await provisionDoc(m1.mount);

        // Ack the create-time schema PUT first (createDatabase flushes on a temp-copy mount), so
        // the one parked write below is exactly the {1,2} upload under test.
        const managed = await m1.mount.createDatabase(docConfig, dataDbId);
        await m1.mount.drainPendingUploads({ flushNow: true });
        expect(m1.mount.pendingUploadCount).toBe(0);

        // Enqueue {1,2} and let the drain enter the PUT, then park it there — the process "dies"
        // with the row + staged copy on disk, inFlight non-empty, and the PUT unacked.
        m1.fault.parkWrites = true;
        managed.db
            .insert(docSchema.items)
            .values([
                { id: 1, data: 'a' },
                { id: 2, data: 'b' },
            ])
            .run();
        await m1.mount.closeDatabase(dataDbId); // enqueues; the kicked drain parks in storage.write
        await waitFor(() => m1.fault.parkedCount === 1);
        expect(m1.mount.pendingUploadCount).toBe(1);

        // "Restart": a fresh mount over the same metadata.db/staging/backing store. reconcile must
        // re-enqueue the persisted row and the replay must land the staged bytes.
        const m2 = createS3Mount('death-mid-put');
        await m2.mount.init();
        await m2.mount.drainPendingUploads({ flushNow: true });
        expect(m2.mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(m2.mount, dataDbId)).toBe(2);
        expect(readdirSync(m2.mount.stagingDir)).toHaveLength(0);

        // The dead process's PUT now lands late. Same key, same staged bytes as the replay —
        // idempotent by design (invariant 6), so the object must not change. Close m1's queue
        // first: a dead process never runs its post-PUT bookkeeping, and letting the live m1
        // resume would misread m2's ack (row gone) as a cancel and delete the object.
        m1.mount.uploadQueue?.close();
        await m1.fault.releaseOldestParked();
        expect(await countBackingRows(m2.mount, dataDbId)).toBe(2);
    });

    test('death after the PUT landed but before the ack bookkeeping: replay re-PUTs, converges, cleans up', async () => {
        const m1 = createS3Mount('death-pre-ack');
        m1.fault.failNextWrites = 9999; // keep the queue from draining on its own
        await m1.mount.init();
        const { dataDbId } = await provisionDoc(m1.mount);
        const managed = await m1.mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await m1.mount.closeDatabase(dataDbId);
        await m1.mount.drainPendingUploads({ flushNow: true });
        expect(m1.mount.pendingUploadCount).toBe(1);

        // Land the staged bytes by hand — the PUT acked, then the process died before the row
        // delete + staging unlink (the crash window between upload-queue.ts:300 and :302).
        const key = buildStorageKey(dataDbId, 'data.db');
        const staged = readdirSync(m1.mount.stagingDir);
        expect(staged).toHaveLength(1);
        m1.fault.failNextWrites = 0;
        await m1.fault.write(key, Bun.file(join(m1.mount.stagingDir, staged[0])));
        expect(await countBackingRows(m1.mount, dataDbId)).toBe(1);

        // Restart: the leftover row replays; the duplicate PUT is idempotent and the row clears.
        const m2 = createS3Mount('death-pre-ack');
        await m2.mount.init();
        await m2.mount.drainPendingUploads({ flushNow: true });
        expect(m2.mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(m2.mount, dataDbId)).toBe(1);
        expect(readdirSync(m2.mount.stagingDir)).toHaveLength(0);
    });
});

describe('corrupted staged copy', () => {
    test('a truncated staged file is dropped, not uploaded: the object stays last-good', async () => {
        const m1 = createS3Mount('staging-truncated');
        await m1.mount.init();
        const { dataDbId } = await provisionDoc(m1.mount);

        // Baseline {1} fully acked → "S3" holds a good object.
        const managed = await m1.mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        await m1.mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(m1.mount, dataDbId)).toBe(1);

        // Outage: a new write {1,2} stages + queues but never acks.
        m1.fault.failNextWrites = 9999;
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await m1.mount.closeDatabase(dataDbId);
        await m1.mount.drainPendingUploads({ flushNow: true });
        expect(m1.mount.pendingUploadCount).toBe(1);

        // Disk damage in the replay window truncates the staged copy to 0 bytes; the durable row
        // survives (the pairing needs the row's WAL commit flushed but not the staging bytes —
        // narrow, but it is the on-disk state a power cut can leave).
        const staged = readdirSync(m1.mount.stagingDir);
        expect(staged).toHaveLength(1);
        await Bun.write(join(m1.mount.stagingDir, staged[0]), new Uint8Array(0));

        // Restart with a healthy backend: reconcile keeps the row (file exists), but the drain
        // refuses to PUT a copy that fails the SQLite magic check (isSqliteFile) — the poison row
        // and staged copy are dropped loudly instead of acking 0 bytes over the good object.
        const m2 = createS3Mount('staging-truncated');
        await m2.mount.init();
        await m2.mount.drainPendingUploads({ flushNow: true });
        expect(m2.mount.pendingUploadCount).toBe(0);
        expect(readdirSync(m2.mount.stagingDir)).toHaveLength(0);

        // The object is left stale-good: the {2} tail edit is lost with its corrupt staged copy,
        // but the good {1} object survives and the doc reopens cleanly.
        expect(await countBackingRows(m2.mount, dataDbId)).toBe(1);
        const reopened = await m2.mount.openDatabase(docConfig, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(1);
    });
});

describe('orphaned PUT past the client-side timeout (performUpload / trackOrphan)', () => {
    // Finding 1 of the upload-queue deep-dive: a PUT stalls past putTimeoutMs (treated as failed),
    // the user's newer bytes land via a later PUT and ack — row deleted, staged copy deleted,
    // local temp cleaned by the doc close. Then the orphan completes server-side and rolls the
    // object back, with nothing queued to re-drive it. The fix retains the acked bytes while the
    // orphan is unsettled and re-uploads them through the guarded path once it settles.
    test('an orphan landing after a newer acked PUT is repaired: the acked bytes are re-uploaded', async () => {
        const m1 = createS3Mount('orphan-regression');
        await m1.mount.init();
        shrinkPutTimeout(m1.mount, 50);
        const { dataDbId } = await provisionDoc(m1.mount);

        // Ack the create-time schema PUT so the one orphan below is exactly the {1} upload.
        const managed = await m1.mount.createDatabase(docConfig, dataDbId);
        await m1.mount.drainPendingUploads({ flushNow: true });
        expect(m1.mount.pendingUploadCount).toBe(0);

        // Sync {1}: its PUT parks (stalled) and the 50ms ceiling fails the attempt into backoff.
        m1.fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush(); // stages {1}, kicks the drain, parks in storage.write
        await waitFor(() => m1.fault.parkedCount === 1);
        await m1.mount.drainPendingUploads(); // returns once the timeout fired and the row backed off
        expect(m1.mount.pendingUploadCount).toBe(1);

        // The user keeps typing and closes the doc: {1,2} stages, supersedes the row, and — with
        // the backend healthy again — PUTs and acks. Queue empty, staging empty, temp cleaned.
        m1.fault.parkWrites = false;
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await m1.mount.closeDatabase(dataDbId);
        await m1.mount.drainPendingUploads({ flushNow: true });
        expect(m1.mount.pendingUploadCount).toBe(0);
        expect(readdirSync(m1.mount.stagingDir)).toHaveLength(0);
        expect(existsSync(m1.mount.getTempPath(dataDbId))).toBe(false);
        expect(await countBackingRows(m1.mount, dataDbId)).toBe(2); // newest bytes are live

        // The orphaned {1} PUT now completes server-side, after the newer object landed. Its
        // settlement re-enqueues the retained {1,2} bytes; wait for that repair to land and ack
        // before simulating the restart (in a real restart the old process is gone).
        await m1.fault.releaseOldestParked();
        await waitFor(
            async () => (await countBackingRows(m1.mount, dataDbId)) === 2 && m1.mount.pendingUploadCount === 0,
        );

        // A later restart+reopen converges on the newest synced bytes {1,2}.
        const m2 = createS3Mount('orphan-regression');
        await m2.mount.init();
        await m2.mount.drainPendingUploads({ flushNow: true });
        const reopened = await m2.mount.openDatabase(docConfig, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(2);
    });

    // Finding 2: invariant 7 had a timeout-shaped hole. The in-time variant is guarded (putOk &&
    // row-gone → delete the resurrected object), but a PUT that times out FIRST has already left
    // performUpload when the cancel lands — the late-landing PUT recreated the deleted object
    // with nothing left to delete it. The fix flags the cancel on the orphan state and re-issues
    // the delete when the orphan settles.
    test('cancel during a timed-out orphaned PUT: the late landing must not leave deleted bytes in storage', async () => {
        const { mount, fault } = createS3Mount('orphan-cancel');
        await mount.init();
        shrinkPutTimeout(mount, 50);
        const { containerId, dataDbId } = await provisionDoc(mount);
        const key = buildStorageKey(dataDbId, 'data.db');

        const managed = await mount.createDatabase(docConfig, dataDbId);
        await mount.drainPendingUploads({ flushNow: true }); // ack the create-time schema PUT
        fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId); // enqueues; drain parks in storage.write
        await waitFor(() => fault.parkedCount === 1);
        await mount.drainPendingUploads(); // 50ms ceiling fires; the attempt is failed into backoff

        // Permanent delete while the orphan is still pending server-side: cancels the row, unlinks
        // the staged copy, deletes the (not-yet-existing) object.
        await mount.deletePath(containerId);
        expect(mount.pendingUploadCount).toBe(0);
        expect(await mount.readFile(dataDbId)).toBeNull();

        // The orphan lands after the delete, resurrecting the object; its settlement re-issues
        // the delete (fire-and-forget), so poll — deleted bytes must not survive in the bucket.
        await fault.releaseOldestParked();
        await waitFor(async () => !(await fault.exists(key)));
        expect(await mount.readFile(dataDbId)).toBeNull(); // invisible to users either way
        expect(await fault.exists(key)).toBe(false);
    });

    // The other cancel ordering: the cancel lands while the PUT is still in flight, BEFORE the
    // timeout fires — cancel() finds no orphan to flag yet. The timeout must infer the cancel from
    // the vanished row (within an in-flight upload only a cancel deletes the row) and flag it, so
    // the late landing is still re-deleted.
    test('cancel during the flight, before the timeout fires: the late landing is still deleted', async () => {
        const { mount, fault } = createS3Mount('orphan-cancel-early');
        await mount.init();
        shrinkPutTimeout(mount, 250);
        const { containerId, dataDbId } = await provisionDoc(mount);
        const key = buildStorageKey(dataDbId, 'data.db');

        const managed = await mount.createDatabase(docConfig, dataDbId);
        await mount.drainPendingUploads({ flushNow: true }); // ack the create-time schema PUT
        fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId); // enqueues; drain parks in storage.write
        await waitFor(() => fault.parkedCount === 1);

        // Permanent delete while the PUT is parked and the 250ms ceiling has NOT fired yet.
        await mount.deletePath(containerId);
        expect(mount.pendingUploadCount).toBe(0);
        await mount.drainPendingUploads(); // returns once the ceiling fired and the PUT was failed

        // The orphan lands after the delete; its settlement must re-issue the delete.
        await fault.releaseOldestParked();
        await waitFor(async () => !(await fault.exists(key)));
        expect(await fault.exists(key)).toBe(false);
    });
});

describe('supersede while a PUT is in flight (no timeout involved)', () => {
    test('a newer enqueue during an in-flight PUT converges to the newest bytes in one drain', async () => {
        const { mount, fault } = createS3Mount('inflight-supersede');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        const managed = await mount.createDatabase(docConfig, dataDbId);
        await mount.drainPendingUploads({ flushNow: true }); // ack the create-time schema PUT

        // PUT {1} parks mid-flight (no timeout — default ceiling). The key is in inFlight, so the
        // superseding enqueue must leave its staged copy alone for the worker to clean up.
        fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        await waitFor(() => fault.parkedCount === 1);

        // Newer bytes {1,2} supersede the row while {1} is mid-PUT.
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await managed.flush();
        expect(mount.pendingUploadCount).toBe(1); // PK upsert: one row, newest staging

        // {1} completes in-time (putOk, but superseded → not an ack); the same drain loop must
        // then pick up the {1,2} row and land it.
        fault.parkWrites = false;
        await fault.releaseOldestParked();
        await mount.drainPendingUploads({ flushNow: true });

        expect(mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(mount, dataDbId)).toBe(2);
        await mount.closeDatabase(dataDbId);
        await mount.drainPendingUploads({ flushNow: true });
        expect(readdirSync(mount.stagingDir)).toHaveLength(0); // both staged copies cleaned up
    });
});
