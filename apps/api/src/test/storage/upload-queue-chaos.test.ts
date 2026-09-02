import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import { buildStorageKey } from '../../lib/mount/helpers';
import type { Mount } from '../../lib/mount/mount';
import { createFaultMount, type FaultStorage, type ParkedWrite } from '../fault-storage-helpers';

// Chaos verification for the "orphaned PUT lands after a newer PUT and regresses the object" class
// (performUpload's Promise.race timeout; repaired in-process via trackOrphan). A PUT that stalls
// past the client-side timeout is treated as failed, but its request body is already on the wire —
// the server can complete it at any later time, invisibly to the process. These tests model that
// with a storage stub that captures each PUT body up-front and lets the test choose WHEN (and in
// what order) each PUT "lands" server-side, and pin the settlement repair.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-upload-queue-chaos-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'chaos-test-doc',
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

// A parked PUT is identified by the row count of the body it captured; memoized per entry so the
// event-driven poll doesn't re-parse the same bytes on every tick.
const parkedRows = new WeakMap<ParkedWrite, number | null>();
async function parkedWithRows(fault: FaultStorage, rows: number): Promise<ParkedWrite> {
    return fault.waitForParked(async (p) => {
        let count = parkedRows.get(p);
        if (count === undefined) {
            count = await countRowsInBytes(p.bytes);
            parkedRows.set(p, count);
        }
        return count === rows;
    });
}

async function countRowsInBytes(bytes: Uint8Array | ArrayBuffer | Buffer | null): Promise<number | null> {
    if (!bytes) return null;
    const verifyPath = join(TEST_DIR, `verify-${Math.random().toString(36).slice(2)}.db`);
    await Bun.write(verifyPath, bytes);
    try {
        const verify = new Database(verifyPath);
        const row = verify.query('SELECT COUNT(*) as c FROM items').get() as { c: number };
        verify.close();
        return row.c;
    } catch {
        return null; // not a valid items db (corruption cases)
    }
}

async function countBackingRows(mount: Mount, fault: FaultStorage, id: string): Promise<number | null> {
    const file = fault.inner.read(await mount.getStorageKey(id));
    if (!file || !(await file.exists())) return null;
    return countRowsInBytes(await file.arrayBuffer());
}

async function provisionDoc(mount: Mount): Promise<{ containerId: string; dataDbId: string }> {
    const rootId = (await mount.getRootFolder())!.id;
    const containerId = await mount.createFolder(rootId, `doc-${Math.random().toString(36).slice(2)}`, 'doc');
    const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
    return { containerId, dataDbId };
}

function shrinkPutTimeout(mount: Mount, ms: number): void {
    (mount.uploadQueue as unknown as { putTimeoutMs: number }).putTimeoutMs = ms;
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await cond())) {
        if (Date.now() > end) throw new Error('waitFor timeout');
        await Bun.sleep(5);
    }
}

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(async () => {
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

describe('orphaned-PUT reorder (performUpload timeout → trackOrphan repair)', () => {
    test('a timed-out PUT landing after a newer acked PUT is repaired — even after the doc closed', async () => {
        const { mount, fault } = createS3Mount('orphan-regress');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        // Baseline {1} fully acked → "S3" holds 1 row.
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        await mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(mount, fault, dataDbId)).toBe(1);

        // Write {2}: its PUT parks (body captured, like a request on the wire) and stalls past the
        // shrunk client-side timeout → the queue treats it as failed and backs off, but the request
        // is still live server-side. This is the orphan.
        shrinkPutTimeout(mount, 50);
        fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await managed.flush();
        await parkedWithRows(fault, 2);
        await Bun.sleep(120); // let the 50ms PUT deadline fire → timeout, inFlight cleared, row backed off

        // Write {3}: a newer sync supersedes the row. Land its PUT immediately (well inside the
        // timeout) → it acks, the row is cleared, the queue believes everything is synced.
        managed.db.insert(docSchema.items).values({ id: 3, data: 'c' }).run();
        await managed.flush();
        const newest = await parkedWithRows(fault, 3);
        await newest.land();
        await waitFor(() => mount.pendingUploadCount === 0);
        expect(await countBackingRows(mount, fault, dataDbId)).toBe(3); // newest write confirmed on "S3"

        // Doc closes cleanly: final sync is clean, so cleanupTemp deletes the local working copy.
        // Locally NOTHING newer than the S3 object remains (no temp, no staged copy, no pending row).
        await mount.closeDatabase(dataDbId);

        // The orphan(s) — every remaining parked PUT carries the older {1,2} bytes — now land
        // server-side, regressing the object. Their settlement logs loudly and re-uploads the
        // retained {1,2,3} bytes through the guarded path, repairing the regression.
        fault.parkWrites = false; // the repair PUT must go straight through
        const errorSpy = spyOn(console, 'error');
        await fault.landAllRemaining();
        await waitFor(() => mount.pendingUploadCount === 0);
        expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('landed after a newer upload acked'))).toBe(true);
        errorSpy.mockRestore();
        expect(await countBackingRows(mount, fault, dataDbId)).toBe(3); // regression repaired

        // "Restart": a fresh mount over the same metadata.db + object store. The repair already
        // acked, so reconcile finds nothing to replay and reopen serves the newest bytes.
        const m2 = createS3Mount('orphan-regress');
        await m2.mount.init();
        const reopened = await m2.mount.openDatabase(docConfig, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(3);
    });

    test('control: a timed-out PUT with NO newer write converges — the retry re-PUTs the same bytes', async () => {
        const { mount, fault } = createS3Mount('orphan-benign');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        shrinkPutTimeout(mount, 50);
        fault.parkWrites = true;
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        await parkedWithRows(fault, 1);
        await Bun.sleep(120); // orphan the PUT

        // Retry with a healthy backend: same staged bytes re-PUT and ack.
        fault.parkWrites = false;
        await mount.drainPendingUploads({ flushNow: true });
        expect(mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(mount, fault, dataDbId)).toBe(1);

        // The orphan lands after the ack — identical bytes, so the object is unchanged. This is the
        // benign half the code comment relies on; it only holds when nothing newer was written.
        // Settlement still re-asserts the retained ack (it can't know the bytes matched), so wait for
        // that repair PUT to finish before reading — otherwise the read races its overwrite.
        await fault.landAllRemaining();
        await waitFor(() => mount.pendingUploadCount === 0);
        expect(await countBackingRows(mount, fault, dataDbId)).toBe(1);
    });

    test('a timed-out PUT landing after a permanent delete: settlement re-deletes the resurrected object', async () => {
        const { mount, fault } = createS3Mount('orphan-zombie');
        await mount.init();
        const { containerId, dataDbId } = await provisionDoc(mount);
        const key = buildStorageKey(dataDbId, 'data.db');

        shrinkPutTimeout(mount, 50);
        fault.parkWrites = true;
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        await parkedWithRows(fault, 1);
        await Bun.sleep(120); // orphan the PUT (timeout fired, inFlight cleared)

        // Permanent delete: cancel() removes the row + staged copy, and the mount deletes the object.
        // The existing cancel-mid-PUT resurrection guard (performUpload's post-PUT re-check) cannot
        // see this orphan — its performUpload call already returned at the timeout.
        await mount.deletePath(containerId);
        expect(mount.pendingUploadCount).toBe(0);
        expect(await fault.inner.exists(key)).toBe(false);

        // The orphan lands after the delete, resurrecting the object — its settlement re-issues
        // the delete (invariant 7), so deleted bytes must not survive in the bucket.
        await fault.landAllRemaining();
        await waitFor(async () => !(await fault.inner.exists(key)));
        expect(await fault.inner.exists(key)).toBe(false);
    });

    // Settlement order says nothing about server commit order: an orphan can settle while the
    // superseding PUT is mid-flight, and its bytes may still have committed AFTER that PUT's. The
    // ack must notice its orphans vanished mid-flight and convert into an immediate re-PUT.
    test('an orphan settling while the newer PUT is mid-flight forces a re-upload', async () => {
        const { mount, fault } = createS3Mount('orphan-midflight');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        // Baseline {1} fully acked.
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        await mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(mount, fault, dataDbId)).toBe(1);

        // Write {2}: its PUT parks and stalls past the ceiling — the orphan.
        shrinkPutTimeout(mount, 150);
        fault.parkWrites = true;
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await managed.flush();
        await parkedWithRows(fault, 2);
        await mount.drainPendingUploads(); // returns once the ceiling fired and the row backed off

        // Write {3}: supersedes the row; its PUT parks mid-flight (well inside its own ceiling).
        managed.db.insert(docSchema.items).values({ id: 3, data: 'c' }).run();
        await managed.flush();
        const newest = await parkedWithRows(fault, 3);

        // Server-side commit order inverts the client view: {1,2,3} commits first (its response
        // still pending), then the orphan lands fully — the object now holds the OLDER {1,2}
        // bytes, and the orphan settles while the {1,2,3} PUT is mid-flight with nothing to
        // repair yet. The subsequent ack must distrust its own commit order and re-PUT.
        await newest.commit();
        await (await parkedWithRows(fault, 2)).land();
        expect(await countBackingRows(mount, fault, dataDbId)).toBe(2); // regressed
        fault.parkWrites = false; // the re-PUT must go straight through
        newest.respond();
        await waitFor(() => mount.pendingUploadCount === 0);
        expect(await countBackingRows(mount, fault, dataDbId)).toBe(3); // newest bytes re-asserted
    });
});

describe('corrupted staged copy (integrity check between VACUUM INTO and PUT)', () => {
    test('a corrupted staging file is dropped before PUT: the object stays last-good and reopens', async () => {
        const { mount, fault } = createS3Mount('staging-corrupt');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);
        const key = buildStorageKey(dataDbId, 'data.db');

        // Baseline {1} acked.
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        await mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(mount, fault, dataDbId)).toBe(1);

        // Write {2}; the PUT fails once so the staged copy sits on disk, then corrupt it (local disk
        // fault / torn write).
        fault.failNextWrites = 1;
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await managed.flush();
        await mount.drainPendingUploads({ flushNow: true });
        const staged = mount.uploadQueue?.getPendingStagingPath(key);
        expect(staged).not.toBeNull();
        await Bun.write(staged!, 'CORRUPT-NOT-A-SQLITE-DB');

        // Retry refuses the garbage (SQLite magic check): the poison row + staged copy are dropped
        // loudly, and the good {1} object stays untouched in storage.
        await mount.drainPendingUploads({ flushNow: true });
        expect(mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(mount, fault, dataDbId)).toBe(1);

        // Clean close deletes the local temp; the stored object is the only copy — stale-good:
        // the {2} tail edit died with its corrupt staged copy, but nothing was wiped or bricked.
        await mount.closeDatabase(dataDbId);
        const m2 = createS3Mount('staging-corrupt');
        await m2.mount.init();
        const reopened = await m2.mount.openDatabase(docConfig, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(1);
    });
});
