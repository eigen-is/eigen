import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { MountConfig, S3Config } from '@workspace/lib/types';
import type { BunFile } from 'bun';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../../lib/core';
import type { ContentExtractor } from '../../lib/mount/content-reindex-queue';
import { buildStorageKey, createDefaultMountConfig } from '../../lib/mount/helpers';
import { Mount } from '../../lib/mount/mount';
import type { StorageBackend, StorageFile } from '../../lib/storage';
import { LocalStorage } from '../../lib/storage/local-storage';
import { getUploadSemaphore, setShutdownDrainDeadline } from '../../lib/sync';
import { DEFAULT_RETENTION } from '../../lib/versioning/retention';

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-sync-resilience-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

const DUMMY_S3: S3Config = {
    endpoint: 'http://127.0.0.1:1',
    bucket: 'test',
    accessKeyId: 'x',
    secretAccessKey: 'y',
    region: 'us-east-1',
    prefix: '',
};

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
    snapshot: { policy: DEFAULT_RETENTION, writesPerSnapshot: 1_000_000 }, // snapshot only when asked
};

// Same schema, no snapshot config — for tests where a close-time version enqueue would just be
// noise (mirrors comments.db, which has no snapshot).
const docConfigNoSnap: DatabaseConfig<typeof docSchema> = {
    name: 'sync-test-doc-nosnap',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

// Wraps a LocalStorage as an S3-like backend with injectable write delays/failures, so the
// async upload pipeline can be exercised deterministically without a real S3. Omits getPath so
// the mount treats it like S3 (temp-copy path), not a path-based local store.
class FaultStorage implements StorageBackend {
    failNextWrites = 0;
    writeDelayMs = 0;
    writeCount = 0;
    // Park every write until the test releases it — models a TCP-black-holed PUT that never resolves,
    // so only the queue's client-side timeout can end the wait.
    hangWrites = false;
    private hungResolvers: Array<() => void> = [];

    constructor(private readonly inner: LocalStorage) {}

    // Let any parked writes proceed so a hung PUT promise doesn't linger past the test.
    releaseHungWrites(): void {
        this.hangWrites = false;
        for (const resolve of this.hungResolvers.splice(0)) resolve();
    }

    read(key: string): StorageFile {
        return this.inner.read(key);
    }
    async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        this.writeCount++;
        // Read the body up-front, like an S3 PUT streaming the request body — so a concurrent
        // unlink of the staging file can't abort an already-started upload. This is what makes
        // the resurrection window (cancel during an in-flight PUT) reproducible.
        const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
        if (this.hangWrites) await new Promise<void>((resolve) => this.hungResolvers.push(resolve));
        if (this.writeDelayMs > 0) await Bun.sleep(this.writeDelayMs);
        if (this.failNextWrites > 0) {
            this.failNextWrites--;
            throw new Error('injected upload failure (503)');
        }
        return this.inner.write(key, bytes);
    }
    async delete(key: string): Promise<boolean> {
        return this.inner.delete(key);
    }
    async exists(key: string): Promise<boolean> {
        return this.inner.exists(key);
    }
    async size(key: string): Promise<number | null> {
        return this.inner.size(key);
    }
}

// Tracks mounts created via createS3Mount so afterEach can stop their self-scheduled retry timers.
const createdMounts: Mount[] = [];

// Same `id` ⇒ same baseDir + backing dir ⇒ a second call simulates a process restart that shares the
// prior mount's metadata.db, staging dir, and "S3" object store. A distinct bucket per id gives each
// mount its own destination semaphore (matching the per-destination design).
function createS3Mount(id: string): { mount: Mount; fault: FaultStorage } {
    const config: MountConfig = {
        id,
        name: id,
        storageType: 's3',
        isDefault: false,
        s3Config: { ...DUMMY_S3, bucket: `bucket-${id}` },
    };
    const mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
    const fault = new FaultStorage(new LocalStorage(join(TEST_DIR, `backing-${id}`)));
    (mount as unknown as { storage: StorageBackend }).storage = fault;
    createdMounts.push(mount);
    return { mount, fault };
}

// Open a throwaway non-WAL copy of a data.db StorageFile and count its rows (a readonly WAL open
// can't create its -shm sidecar).
async function countRowsInFile(file: StorageFile | null): Promise<number | null> {
    if (!file || !(await file.exists())) return null;
    const verifyPath = join(TEST_DIR, `verify-${Math.random().toString(36).slice(2)}.db`);
    await Bun.write(verifyPath, await file.arrayBuffer());
    const verify = new Database(verifyPath);
    const row = verify.query('SELECT COUNT(*) as c FROM items').get() as { c: number };
    verify.close();
    return row.c;
}

// Count rows in the object that actually reached the backing store ("S3"/local). Reads storage
// directly — NOT via mount.readFile, which is freshest-first and would surface un-acked staged
// bytes; getStorageKey handles both the flat-key (s3) and hierarchical (local) layouts.
async function countBackingRows(mount: Mount, id: string): Promise<number | null> {
    const m = mount as unknown as { storage: StorageBackend; getStorageKey(id: string): Promise<string> };
    return countRowsInFile(m.storage.read(await m.getStorageKey(id)));
}

async function provisionDoc(mount: Mount): Promise<{ containerId: string; dataDbId: string }> {
    const rootId = (await mount.getRootFolder())!.id;
    const containerId = await mount.createFolder(rootId, `doc-${Math.random().toString(36).slice(2)}`, 'doc');
    const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
    return { containerId, dataDbId };
}

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
// Stop each test's mounts so their per-queue self-scheduled retry timers don't linger (a backed-off
// upload in an outage test would otherwise keep the event loop alive after the test).
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

        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'synced' }).run();
        await mount.closeDatabase(dataDbId);
        expect(await countBackingRows(mount, dataDbId)).toBe(1);

        // Simulate a crash: rebuild the temp from the backing store, add an UNSYNCED row, and
        // leave it behind exactly as an unclean shutdown would (no clean close ran).
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

        await mount.openDatabase(docConfig, dataDbId);
        await mount.closeDatabase(dataDbId);

        // Without Phase 1a's markDirty(), the reopened DB looked clean and cleanupTemp dropped row 2.
        expect(await countBackingRows(mount, dataDbId)).toBe(2);
    });
});

describe('Phase 1b — write-behind upload pipeline', () => {
    test('upload is off the request/close path; a slow PUT does not block create or close', async () => {
        const { mount, fault } = createS3Mount('async-latency');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        fault.writeDelayMs = 2_000; // every PUT is slow — awaiting even one would dominate the timing
        const start = Bun.nanoseconds();
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;

        // create+close returned in a small fraction of one 2s PUT → they did not await the PUT.
        expect(elapsedMs).toBeLessThan(500);
        expect(mount.pendingUploadCount).toBeGreaterThan(0); // the upload is queued, not yet done
        fault.writeDelayMs = 0; // don't make the verification drain slow too
        await mount.drainPendingUploads({ flushNow: true }); // now await the upload
        expect(mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(mount, dataDbId)).toBe(1);
    });

    test('a failing backend keeps writes durably queued; recovery uploads them (no data loss)', async () => {
        const { mount, fault } = createS3Mount('outage-retry');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        fault.failNextWrites = 9999; // outage
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        await mount.drainPendingUploads({ flushNow: true });

        expect(mount.pendingUploadCount).toBeGreaterThan(0); // queued, not lost
        expect(await countBackingRows(mount, dataDbId)).toBeNull(); // nothing reached "S3"

        fault.failNextWrites = 0; // outage over
        await mount.drainPendingUploads({ flushNow: true });
        expect(mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(mount, dataDbId)).toBe(1);
        expect(readdirSync(mount.stagingDir)).toHaveLength(0); // staged copies cleaned up on ack
    });

    test('last-write-wins: rapid syncs collapse to one pending row and upload the final bytes', async () => {
        const { mount, fault } = createS3Mount('last-write-wins');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        fault.failNextWrites = 9999; // hold all uploads so syncs queue up
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await managed.flush();
        await mount.drainPendingUploads({ flushNow: true });

        expect(mount.pendingUploadCount).toBe(1); // one row per key, newest wins

        fault.failNextWrites = 0;
        await mount.closeDatabase(dataDbId);
        await mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(mount, dataDbId)).toBe(2); // final state, not a stale snapshot
    });

    test('after an outage + restart, reopen recovers newest bytes from staging, not stale storage', async () => {
        // Mount 1: edit + close during an outage. Bytes are staged + queued but never reach "S3".
        const m1 = createS3Mount('crash-staging');
        m1.fault.failNextWrites = 9999;
        await m1.mount.init();
        const { dataDbId } = await provisionDoc(m1.mount);
        const managed1 = await m1.mount.createDatabase(docConfig, dataDbId);
        managed1.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        managed1.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await m1.mount.closeDatabase(dataDbId);
        await m1.mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(m1.mount, dataDbId)).toBeNull(); // not in "S3"

        // Mount 2: a "restart" sharing the same baseDir + object store; outage still ongoing.
        const m2 = createS3Mount('crash-staging');
        m2.fault.failNextWrites = 9999;
        await m2.mount.init(); // reconcile re-enqueues the persisted pending upload

        // Reopening must surface the staged (newest) bytes, NOT download a stale/absent object.
        const managed2 = await m2.mount.openDatabase(docConfig, dataDbId);
        expect(managed2.db.select().from(docSchema.items).all()).toHaveLength(2);
        await m2.mount.closeDatabase(dataDbId);

        m2.fault.failNextWrites = 0; // outage over
        await m2.mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(m2.mount, dataDbId)).toBe(2);
    });

    test('startup reconcile resumes a persisted pending upload on a fresh mount', async () => {
        const m1 = createS3Mount('reconcile');
        m1.fault.failNextWrites = 9999;
        await m1.mount.init();
        const { dataDbId } = await provisionDoc(m1.mount);
        const managed1 = await m1.mount.createDatabase(docConfig, dataDbId);
        managed1.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await m1.mount.closeDatabase(dataDbId);
        await m1.mount.drainPendingUploads({ flushNow: true });
        expect(m1.mount.pendingUploadCount).toBeGreaterThan(0);

        // Restart with a healthy backend: init() reconciles + kicks the drain.
        const m2 = createS3Mount('reconcile');
        await m2.mount.init();
        await m2.mount.drainPendingUploads({ flushNow: true });
        expect(m2.mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(m2.mount, dataDbId)).toBe(1);
    });

    test('permanent delete cancels queued uploads so they cannot resurrect the object', async () => {
        const { mount, fault } = createS3Mount('delete-cancel');
        await mount.init();
        const { containerId, dataDbId } = await provisionDoc(mount);

        fault.failNextWrites = 9999;
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId); // also enqueues a close-time version snapshot
        await mount.drainPendingUploads({ flushNow: true });
        expect(mount.pendingUploadCount).toBeGreaterThan(0);

        // Permanently delete the whole doc — recursively cancels every queued upload + staged copy.
        await mount.deletePath(containerId);
        expect(mount.pendingUploadCount).toBe(0);
        expect(readdirSync(mount.stagingDir)).toHaveLength(0);

        fault.failNextWrites = 0;
        await mount.drainPendingUploads({ flushNow: true });
        expect(await mount.readFile(dataDbId)).toBeNull(); // never resurrected
    });

    test('shutdown flush drains the queue within its deadline before metadata.db closes', async () => {
        const { mount, fault } = createS3Mount('shutdown-flush');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        fault.writeDelayMs = 150; // slow but working
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        // Leave the doc OPEN: closeAllDatabases must close it (final enqueue) AND flush.

        setShutdownDrainDeadline(Date.now() + 5_000);
        await mount.closeAllDatabases();
        setShutdownDrainDeadline(null);

        expect(mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(mount, dataDbId)).toBe(1);
    });

    test('shutdown flush is bounded under a slow-AND-failing backend (the real incident shape)', async () => {
        const { mount, fault } = createS3Mount('shutdown-bounded');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        fault.writeDelayMs = 2_000; // slow…
        fault.failNextWrites = 9999; // …then 503 — Hetzner's degraded shape, not an instant fail
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();

        setShutdownDrainDeadline(Date.now() + 300);
        const start = Bun.nanoseconds();
        await mount.closeAllDatabases();
        const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
        setShutdownDrainDeadline(null);

        // The deadline bounds when the loop STARTS new PUTs; an already-in-flight PUT still runs
        // to completion, so the bound is ≈ deadline + one PUT (~2s here), never N×PUT. A PUT that
        // overruns the process grace period is SIGKILLed and replays on boot — no data loss.
        expect(elapsedMs).toBeLessThan(4_000);
        expect(mount.pendingUploadCount).toBeGreaterThan(0); // left queued for boot replay
    });

    test('§3 version snapshot captures current bytes from staging, not the stale stored object', async () => {
        const { mount, fault } = createS3Mount('version-staging');
        await mount.init();
        const { containerId, dataDbId } = await provisionDoc(mount);

        // Baseline {1} fully uploaded + acked → "S3" holds {1}.
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        await mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(mount, dataDbId)).toBe(1);

        // Outage + a new write {2}: the live/staged state is {1,2} but "S3" is still {1}.
        fault.failNextWrites = 9999;
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await managed.flush();

        // Snapshot while stale: the version must reflect {1,2} (from staging), not the {1} in storage.
        await mount.snapshotContainerDataDb(containerId, DEFAULT_RETENTION);
        const versionsId = (await mount.getChildByName(containerId, 'versions'))!.id;
        const versionId = (await mount.listFolder(versionsId))[0].id;

        fault.failNextWrites = 0;
        await mount.closeDatabase(dataDbId);
        await mount.drainPendingUploads({ flushNow: true });

        expect(await countBackingRows(mount, versionId)).toBe(2); // current bytes, not stale {1}
    });

    test('a delete landing during an in-flight PUT does not resurrect the deleted object', async () => {
        const { mount, fault } = createS3Mount('resurrect-guard');
        await mount.init();
        const { containerId, dataDbId } = await provisionDoc(mount);
        const key = buildStorageKey(dataDbId, 'data.db');

        const managed = await mount.createDatabase(docConfigNoSnap, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId); // enqueue

        fault.writeDelayMs = 1_000; // hold the PUT in flight (its body was already read up-front)
        const draining = mount.drainPendingUploads({ flushNow: true });
        await Bun.sleep(150); // let performUpload enter storage.write — the object is mid-upload
        await mount.deletePath(containerId); // cancel + storage.delete while the PUT is in flight
        await draining; // PUT completes after the delay → the guard must delete what it resurrected

        expect(mount.pendingUploadCount).toBe(0);
        expect(await fault.exists(key)).toBe(false); // NOT resurrected
        expect(readdirSync(mount.stagingDir)).toHaveLength(0);
    });

    test('a container with two managed DBs (data.db + comments.db) both upload under the queue', async () => {
        const { mount, fault } = createS3Mount('two-managed-dbs');
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;
        const containerId = await mount.createFolder(rootId, 'room', 'chat');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
        const commentsId = await mount.touchFile(containerId, 'comments.db', 'application/x-sqlite3');

        fault.failNextWrites = 9999; // outage holds both
        const data = await mount.createDatabase(docConfigNoSnap, dataDbId);
        data.db.insert(docSchema.items).values({ id: 1, data: 'd' }).run();
        await mount.closeDatabase(dataDbId);
        const comments = await mount.createDatabase(docConfigNoSnap, commentsId);
        comments.db.insert(docSchema.items).values({ id: 1, data: 'c' }).run();
        await mount.closeDatabase(commentsId);
        await mount.drainPendingUploads({ flushNow: true });
        expect(mount.pendingUploadCount).toBe(2); // two distinct keys queued, no collision

        fault.failNextWrites = 0; // recovery uploads both
        await mount.drainPendingUploads({ flushNow: true });
        expect(mount.pendingUploadCount).toBe(0);
        expect(await countBackingRows(mount, dataDbId)).toBe(1);
        expect(await countBackingRows(mount, commentsId)).toBe(1);
    });

    test('reconcile resumes the real pending upload and sweeps an orphan staging file', async () => {
        const m1 = createS3Mount('reconcile-orphan');
        m1.fault.failNextWrites = 9999;
        await m1.mount.init();
        const { dataDbId } = await provisionDoc(m1.mount);
        const managed = await m1.mount.createDatabase(docConfigNoSnap, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await m1.mount.closeDatabase(dataDbId);
        await m1.mount.drainPendingUploads({ flushNow: true });
        expect(m1.mount.pendingUploadCount).toBe(1);

        // Plant an orphan staging file (a crash between stageCopy and the row insert leaves one).
        const orphan = join(m1.mount.stagingDir, `${randomUUID()}.db`);
        await Bun.write(orphan, 'garbage-referenced-by-no-row');
        expect(readdirSync(m1.mount.stagingDir)).toHaveLength(2);

        // Restart sharing the same baseDir: reconcile keeps the referenced staging, sweeps the orphan.
        const m2 = createS3Mount('reconcile-orphan');
        m2.fault.failNextWrites = 9999;
        await m2.mount.init();
        expect(m2.mount.pendingUploadCount).toBe(1);
        expect(existsSync(orphan)).toBe(false);
        expect(readdirSync(m2.mount.stagingDir)).toHaveLength(1);

        m2.fault.failNextWrites = 0; // and the real one still uploads
        await m2.mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(m2.mount, dataDbId)).toBe(1);
    });

    test('idle teardown during an in-flight PUT bails cleanly and leaves the row for replay', async () => {
        const { mount, fault } = createS3Mount('idle-teardown');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);
        const managed = await mount.createDatabase(docConfigNoSnap, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId); // enqueue; mount still live

        fault.writeDelayMs = 500; // hold the PUT in flight
        const draining = mount.drainPendingUploads(); // background drain, no flush
        await Bun.sleep(100);
        // Idle teardown (no shutdown deadline): sets uploadClosing + unregisters, does NOT await the
        // in-flight PUT. The drain must then bail via its uploadClosing guards without throwing.
        await mount.closeAllDatabases();
        await draining; // resolves cleanly — no DB-after-close error

        fault.writeDelayMs = 0;
        expect(mount.pendingUploadCount).toBeGreaterThan(0); // row preserved for replay on reopen
    });
});

describe('P2-6a — copy freshest-source, staging relocation, tmp-sweep recovery', () => {
    test('copying a doc container with a pending (un-acked) data.db upload copies the fresh staged bytes, not the stale storage object', async () => {
        const { mount, fault } = createS3Mount('copy-pending');
        await mount.init();
        const { containerId, dataDbId } = await provisionDoc(mount);
        const rootId = (await mount.getRootFolder())!.id;

        // Baseline {1} fully acked → "S3" holds {1}.
        const managed = await mount.createDatabase(docConfigNoSnap, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await managed.flush();
        await mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(mount, dataDbId)).toBe(1);

        // A new write {2} whose upload is HELD in-flight: the staged {1,2} copy + pending row exist,
        // but "S3" is still {1}. writeDelayMs keeps that PUT from acking; reset to 0 (after the drain
        // has entered the sleeping PUT) so the copy's own writes land on a healthy backend.
        fault.writeDelayMs = 2_000;
        managed.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await managed.flush();
        await Bun.sleep(100);
        fault.writeDelayMs = 0;
        expect(mount.pendingUploadCount).toBe(1);
        expect(await countBackingRows(mount, dataDbId)).toBe(1); // "S3" still stale {1}

        // readFile is freshest-first (the seam behind downloadFile / copyPathAcross): it must surface
        // the staged {1,2}, not the stale {1} in storage.
        expect(await countRowsInFile(await mount.readFile(dataDbId))).toBe(2);

        // Copy the whole container: the recursion into data.db must copy the staged {1,2}, not "S3" {1}.
        const copy = await mount.copyPath(containerId, rootId, 'doc-copy');
        const copiedDataDb = (await mount.getChildByName(copy.id, 'data.db'))!;
        expect(await countBackingRows(mount, copiedDataDb.id)).toBe(2);

        // Duplicate-then-delete-original preserves the copied data.
        await mount.deletePath(containerId);
        expect(await countBackingRows(mount, copiedDataDb.id)).toBe(2);
    });

    test('a data-dir relocation keeps pending uploads (stagingPath resolves against the current stagingDir)', async () => {
        const id = `relocate-${Date.now()}`;
        // The "S3" backing store is remote — a host migration does NOT move it; only the local data dir moves.
        const backing = new FaultStorage(new LocalStorage(join(TEST_DIR, `backing-${id}`)));
        const config: MountConfig = {
            id,
            name: id,
            storageType: 's3',
            isDefault: false,
            s3Config: { ...DUMMY_S3, bucket: `bucket-${id}` },
        };

        // Original data dir A: stage a pending upload during an outage so it survives to relocation time.
        const baseA = join(TEST_DIR, `relocate-A-${id}`);
        const mountA = new Mount(OWNER_ID, baseA, config, createGetLocalDatabase(baseA));
        (mountA as unknown as { storage: StorageBackend }).storage = backing;
        createdMounts.push(mountA);
        backing.failNextWrites = 9999;
        await mountA.init();
        const { dataDbId } = await provisionDoc(mountA);
        const managed = await mountA.createDatabase(docConfigNoSnap, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mountA.closeDatabase(dataDbId);
        await mountA.drainPendingUploads({ flushNow: true });
        expect(mountA.pendingUploadCount).toBe(1);
        await mountA.closeAllDatabases(); // idle teardown — leaves the row + staged copy for replay

        // Relocate: move the local data dir A → B (host migration / restore-from-backup). metadata.db
        // and staging/ move together; the "S3" backing is unchanged.
        const baseB = join(TEST_DIR, `relocate-B-${id}`);
        mkdirSync(baseB, { recursive: true });
        renameSync(join(baseA, 'mounts'), join(baseB, 'mounts'));

        const mountB = new Mount(OWNER_ID, baseB, config, createGetLocalDatabase(baseB));
        (mountB as unknown as { storage: StorageBackend }).storage = backing;
        createdMounts.push(mountB);
        await mountB.init(); // reconcile: the basename resolves against B's stagingDir → row survives

        expect(mountB.pendingUploadCount).toBe(1); // the pending upload was NOT dropped by the move
        expect(readdirSync(mountB.stagingDir)).toHaveLength(1); // its staged bytes were not swept

        backing.failNextWrites = 0; // outage over — the relocated upload still drains
        await mountB.drainPendingUploads({ flushNow: true });
        expect(mountB.pendingUploadCount).toBe(0);
        expect(await countBackingRows(mountB, dataDbId)).toBe(1);
    });

    test("a delayed restart preserves an open doc's crash-recovery temp but sweeps stale transient temps", async () => {
        const { mount } = createS3Mount('tmp-sweep-restart');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount); // dataDbId is a live paths.id

        // A crash-recovery working copy: a temp named after the LIVE data.db pathId. A transient
        // stream/upload temp: named after a random id that is NOT a paths row. Both aged past 1h.
        const recoveryTemp = mount.getTempPath(dataDbId);
        await Bun.write(recoveryTemp, 'live-doc-working-copy');
        const orphanTemp = mount.getTempPath(randomUUID());
        await Bun.write(orphanTemp, 'stale-transient-temp');
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        utimesSync(recoveryTemp, old, old);
        utimesSync(orphanTemp, old, old);

        // A restart sharing the same baseDir re-runs the init-time tmp sweep.
        const m2 = createS3Mount('tmp-sweep-restart');
        await m2.mount.init();

        expect(existsSync(recoveryTemp)).toBe(true); // recovery temp survives for reopen to adopt
        expect(existsSync(orphanTemp)).toBe(false); // transient temp still swept
    });
});

describe('per-destination upload concurrency', () => {
    test('each S3 destination gets its own semaphore; the same destination shares one', () => {
        // Distinct Semaphore instances per destination ⇒ independent permit pools ⇒ a slow/down
        // provider only backs up its own uploads and never blocks uploads to other destinations.
        const bucketA = getUploadSemaphore('https://s3.example//bucket-a');
        const bucketAAgain = getUploadSemaphore('https://s3.example//bucket-a');
        const bucketB = getUploadSemaphore('https://s3.example//bucket-b');
        expect(bucketA).toBe(bucketAAgain);
        expect(bucketA).not.toBe(bucketB);
    });
});

// The 2026-06-08 incident: an S3 read hiccup during a redeploy left an empty/0-byte temp, which
// crash-recovery (Phase 1a) adopted and re-uploaded OVER the good stored object — wiping two live
// stickies docs, then re-wiping on every later redeploy. Recovery must refuse an empty/invalid/
// collapsed temp and re-fetch the authoritative object, never overwrite real data with an empty db.
describe('data-loss guard — crash recovery must not overwrite a good object with an empty temp', () => {
    test('a 0-byte crash temp is discarded; the stored object is re-fetched, not wiped', async () => {
        const { mount } = createS3Mount('empty-temp-guard');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        // A real, fully-uploaded stored object {1,2,3}.
        const managed = await mount.createDatabase(docConfigNoSnap, dataDbId);
        managed.db
            .insert(docSchema.items)
            .values([
                { id: 1, data: 'a' },
                { id: 2, data: 'b' },
                { id: 3, data: 'c' },
            ])
            .run();
        await mount.closeDatabase(dataDbId);
        await mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(mount, dataDbId)).toBe(3);

        // Unclean shutdown leaves a poison temp: a 0-byte file from an interrupted/empty GET.
        await Bun.write(mount.getTempPath(dataDbId), new Uint8Array(0));

        // Reopen must recover the real object, not adopt the empty temp as a fresh doc.
        const reopened = await mount.openDatabase(docConfigNoSnap, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(3);

        await mount.closeDatabase(dataDbId);
        await mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(mount, dataDbId)).toBe(3); // good object intact, not overwritten
    });

    test('a valid but content-empty temp does not collapse a larger stored object', async () => {
        const { mount } = createS3Mount('collapse-temp-guard');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        // Stored object with substantial content (well above the small-doc floor).
        const managed = await mount.createDatabase(docConfigNoSnap, dataDbId);
        for (let i = 0; i < 500; i++) {
            managed.db
                .insert(docSchema.items)
                .values({ id: i, data: 'x'.repeat(1000) })
                .run();
        }
        await managed.flush();
        await mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(mount, dataDbId)).toBe(500);
        await mount.closeDatabase(dataDbId);

        // Poison temp: a VALID but freshly-initialized (0-row) SQLite — passes a header check but is
        // a tiny fraction of the stored object. This is the shape that reached S3 in the incident, so
        // build it exactly the way the code creates a fresh db (schema + migrations, then 0 rows).
        const emptyTemp = new ManagedDatabase(docConfigNoSnap, mount.getTempPath(dataDbId));
        await emptyTemp.open(0);
        await emptyTemp.close({ skipFinalSnapshot: true });

        const reopened = await mount.openDatabase(docConfigNoSnap, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(500);

        await mount.closeDatabase(dataDbId);
        await mount.drainPendingUploads({ flushNow: true });
        expect(await countBackingRows(mount, dataDbId)).toBe(500); // not collapsed to empty
    });
});

describe('P2-6b — mount lifecycle/robustness (reindex teardown order, prune-timer race, PUT timeout)', () => {
    // Finding 1: closeAllDatabases must AWAIT the reindex drain before it clears documentDbs. A late
    // extract opens a doc DB via mount.openDatabase and relies on the mount lifecycle to close it; if
    // teardown returns before that open, the DB lands in the just-cleared cache and leaks forever.
    test('closeAllDatabases awaits the reindex drain so a late extract-opened DB is not leaked', async () => {
        let extractEntered!: () => void;
        const entered = new Promise<void>((r) => (extractEntered = r));
        let releaseExtract!: () => void;
        const gate = new Promise<void>((r) => (releaseExtract = r));
        let leakDbId = '';

        // Gate BEFORE the open so the open can be forced to land after teardown clears the cache.
        const extract: ContentExtractor = async (m) => {
            extractEntered();
            await gate;
            await m.openDatabase(docConfigNoSnap, leakDbId);
            return '';
        };

        const mount = new Mount(
            OWNER_ID,
            TEST_DIR,
            createDefaultMountConfig(`reindex-teardown-${Date.now()}`, 'local'),
            createGetLocalDatabase(TEST_DIR),
            extract,
        );
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;

        // A real data.db for the extractor to (re)open mid-drain (created, then evicted from the cache).
        const containerId = await mount.createFolder(rootId, 'leak-doc', 'doc');
        leakDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
        await mount.createDatabase(docConfigNoSnap, leakDbId);
        await mount.closeDatabase(leakDbId);

        // A searchable text file dirties a row → the reindexer drains it → extract runs and parks.
        await mount.createFile(rootId, 'note.txt', 'text/plain', 5, Buffer.from('hello'));
        const draining = mount.flushContentReindex(); // handle to the in-flight drain loop
        await entered; // extract is parked at the gate, before its open

        const documentDbs = mount.documentDbs;

        // Tear down while the extract is mid-flight, THEN let it open its DB. Pre-fix: teardown returns
        // before the open, which lands in the cleared cache and leaks. Post-fix: teardown awaits the
        // drain, so the opened DB lands in the cache and the close pass closes it.
        const closing = mount.closeAllDatabases();
        releaseExtract();
        await closing;
        await draining;

        expect(documentDbs.size).toBe(0);
    });

    // Finding 2: init schedules setTimeout(history.prune, 0) off the ready path; a fast teardown must
    // cancel it, or it fires against a metadata.db the Home is about to close ("Cannot use a closed
    // database" noise).
    test('a fast open→teardown cancels the pending history prune', async () => {
        const mount = new Mount(
            OWNER_ID,
            TEST_DIR,
            createDefaultMountConfig(`prune-race-${Date.now()}`, 'local'),
            createGetLocalDatabase(TEST_DIR),
        );
        await mount.init(); // schedules the setTimeout(prune, 0) — still pending (a macrotask)

        let pruneRuns = 0;
        const history = (mount as unknown as { history: { prune: () => void } }).history;
        history.prune = () => {
            pruneRuns++;
        };

        await mount.closeAllDatabases(); // must clearTimeout the pending prune
        await new Promise((r) => setTimeout(r, 0)); // let any surviving macrotask fire

        expect(pruneRuns).toBe(0);
    });

    // Finding 3: a PUT that never resolves must hit the queue's client-side timeout and be treated as
    // a failure (back off, release the semaphore, advance the loop), not hang the drain forever.
    test('a hung PUT times out and backs off instead of stalling the queue', async () => {
        const { mount, fault } = createS3Mount(`put-timeout-${Date.now()}`);
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        // Bound the race deterministically: the injected write never resolves, so only the timeout can
        // settle it. 50ms keeps the test fast; production uses UPLOAD_PUT_TIMEOUT_MS (120s).
        (mount.uploadQueue as unknown as { putTimeoutMs: number }).putTimeoutMs = 50;
        fault.hangWrites = true;

        const managed = await mount.createDatabase(docConfigNoSnap, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId); // enqueues the upload

        // Pre-fix: storage.write never resolves → this drain never returns (the test times out).
        // Post-fix: the PUT deadline fires, performUpload treats it as a failure and backs off.
        await mount.drainPendingUploads({ flushNow: true });

        expect(fault.writeCount).toBeGreaterThan(0); // the PUT was attempted…
        expect(mount.pendingUploadCount).toBeGreaterThan(0); // …and left queued (backed off), not hung/cleared

        fault.releaseHungWrites(); // settle the orphaned PUT so nothing lingers
    }, 5_000);

    // Batch-2 review: close() awaits the in-flight drain, whose extract does unbounded storage GETs
    // via the doc loaders — the same black-hole class the PUT ceiling exists for, and idle-home
    // eviction has no SIGKILL backstop. The await must be bounded so teardown proceeds past a hung
    // extract (accepting it as leaked, no worse than the pre-6b leak).
    test('a hung extract cannot park closeAllDatabases forever (bounded reindex close)', async () => {
        let extractEntered!: () => void;
        const entered = new Promise<void>((r) => (extractEntered = r));

        // Models an extract parked on a black-holed storage GET — never resolves.
        const extract: ContentExtractor = async () => {
            extractEntered();
            return new Promise<string>(() => {});
        };

        const mount = new Mount(
            OWNER_ID,
            TEST_DIR,
            createDefaultMountConfig(`reindex-close-timeout-${Date.now()}`, 'local'),
            createGetLocalDatabase(TEST_DIR),
            extract,
        );
        await mount.init();
        const rootId = (await mount.getRootFolder())!.id;

        // A searchable file dirties a row; createFile's kick starts the drain, which parks in extract.
        await mount.createFile(rootId, 'note.txt', 'text/plain', 5, Buffer.from('hello'));
        await entered;

        (mount.reindexQueue as unknown as { closeTimeoutMs: number }).closeTimeoutMs = 50;

        // Pre-fix: close() awaits the parked drain unboundedly → this never returns (test times out).
        await mount.closeAllDatabases();
    }, 5_000);
});
