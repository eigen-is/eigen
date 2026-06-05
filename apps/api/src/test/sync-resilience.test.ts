import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { MountConfig, S3Config } from '@workspace/lib/types';
import type { BunFile } from 'bun';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import { createDefaultMountConfig, Mount } from '../lib/mount/mount';
import type { StorageBackend, StorageFile } from '../lib/storage';
import { LocalStorage } from '../lib/storage/local-storage';
import { setShutdownDrainDeadline } from '../lib/sync';
import { DEFAULT_RETENTION } from '../lib/versioning/retention';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-sync-resilience-${Date.now()}`);
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

// Wraps a LocalStorage as an S3-like backend with injectable write delays/failures, so the
// async upload pipeline can be exercised deterministically without a real S3. Omits getPath so
// the mount treats it like S3 (temp-copy path), not a path-based local store.
class FaultStorage implements StorageBackend {
    failNextWrites = 0;
    writeDelayMs = 0;
    writeCount = 0;

    constructor(private readonly inner: LocalStorage) {}

    read(key: string): StorageFile {
        return this.inner.read(key);
    }
    async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        this.writeCount++;
        if (this.writeDelayMs > 0) await Bun.sleep(this.writeDelayMs);
        if (this.failNextWrites > 0) {
            this.failNextWrites--;
            throw new Error('injected upload failure (503)');
        }
        return this.inner.write(key, data);
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

// Same `id` ⇒ same baseDir + backing dir ⇒ a second call simulates a process restart that
// shares the prior mount's metadata.db, staging dir, and "S3" object store.
function createS3Mount(id: string): { mount: Mount; fault: FaultStorage } {
    const config: MountConfig = { id, name: id, storageType: 's3', isDefault: false, s3Config: DUMMY_S3 };
    const mount = new Mount(OWNER_ID, TEST_DIR, config, createGetLocalDatabase(TEST_DIR));
    const fault = new FaultStorage(new LocalStorage(join(TEST_DIR, `backing-${id}`)));
    (mount as unknown as { storage: StorageBackend }).storage = fault;
    return { mount, fault };
}

// Count rows in the backing-store ("S3") copy of a data.db. Reads through the mount's storage
// and opens a throwaway non-WAL copy (a readonly WAL open can't create its -shm sidecar).
async function countBackingRows(mount: Mount, dataDbId: string): Promise<number | null> {
    const file = await mount.readFile(dataDbId);
    if (!file) return null;
    const verifyPath = join(TEST_DIR, `verify-${Math.random().toString(36).slice(2)}.db`);
    await Bun.write(verifyPath, await file.arrayBuffer());
    const verify = new Database(verifyPath);
    const row = verify.query('SELECT COUNT(*) as c FROM items').get() as { c: number };
    verify.close();
    return row.c;
}

async function provisionDoc(mount: Mount): Promise<{ containerId: string; dataDbId: string }> {
    const rootId = (await mount.getRootFolder())!.id;
    const containerId = await mount.createFolder(rootId, `doc-${Math.random().toString(36).slice(2)}`, 'doc');
    const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
    return { containerId, dataDbId };
}

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => {
    setShutdownDrainDeadline(null);
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

        fault.writeDelayMs = 400; // every PUT is slow
        const start = Bun.nanoseconds();
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;

        expect(elapsedMs).toBeLessThan(400); // returned before the background PUT could finish
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

    test('shutdown flush is bounded — a dead backend does not hang the drain past its deadline', async () => {
        const { mount, fault } = createS3Mount('shutdown-bounded');
        await mount.init();
        const { dataDbId } = await provisionDoc(mount);

        fault.failNextWrites = 9999; // dead backend
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();

        setShutdownDrainDeadline(Date.now() + 300);
        const start = Bun.nanoseconds();
        await mount.closeAllDatabases();
        const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
        setShutdownDrainDeadline(null);

        expect(elapsedMs).toBeLessThan(3_000); // did not hang on the dead backend
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
});
