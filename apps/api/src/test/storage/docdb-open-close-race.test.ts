import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { BunFile } from 'bun';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import { ApiError, ManagedDatabase } from '../../lib/core';
import { HOLDER_WAIT_MS, IDLE_CLOSE_MS } from '../../lib/mount/document-db';
import { Mount } from '../../lib/mount/mount';
import { LocalStorage } from '../../lib/storage/local-storage';
import { DEFAULT_RETENTION } from '../../lib/versioning/retention';
import { VERSIONS_FOLDER_NAME } from '../../lib/versioning/versions-folder';
import {
    countRowsInFile,
    createGetLocalDatabase,
    SETTLE_BOUND_MS,
    STALL_BOUND_MS,
    settlesWithin,
} from '../fault-storage-helpers';
import { createTestMountConfig } from '../mount-test-helpers';

// Regression net for the open/close serialization in docs/SYNC.md: every open, create and close of
// one pathId queues on its mount.documentDbs slot, and tick/close snapshots never park on the
// container lock (the H→F→C deadlock).

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-docdb-open-close-race-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'race-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};
// writesPerSnapshot 1: any write makes the next tick/close snapshot due.
const snapshotDocConfig: DatabaseConfig<typeof docSchema> = {
    ...docConfig,
    name: 'race-doc-snap',
    snapshot: { policy: DEFAULT_RETENTION, writesPerSnapshot: 1 },
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

type Gate = { parked: Promise<void>; release: () => void };

// LocalStorage whose next write() or read after arm parks on a test-controlled gate (a write can
// also be failed) — freezes a close mid-final-sync so a concurrent open
// lands deterministically in the close window. One-shot: the arm is consumed synchronously at park time, so every other
// call passes straight through. No sleeps anywhere — pure deferreds.
class GatedLocalStorage extends LocalStorage {
    private writeGate: { parked: () => void; released: Promise<void> } | null = null;
    private readGate: { parked: () => void; released: Promise<void> } | null = null;

    public armWrite(): Gate & { fail: (err: Error) => void } {
        const parked = deferred();
        const released = Promise.withResolvers<void>();
        this.writeGate = { parked: parked.resolve, released: released.promise };
        return { parked: parked.promise, release: released.resolve, fail: released.reject };
    }

    // Parks the next download before its first byte, holding the open mid-load like a stalled GET.
    public armRead(): Gate & { fail: (err: Error) => void } {
        const parked = deferred();
        const released = Promise.withResolvers<void>();
        this.readGate = { parked: parked.resolve, released: released.promise };
        return { parked: parked.promise, release: released.resolve, fail: released.reject };
    }

    public override async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const gate = this.writeGate;
        if (gate) {
            this.writeGate = null;
            gate.parked();
            await gate.released;
        }
        return super.write(key, data);
    }

    // Gated at stream() rather than read(): exists() and size() read the same handle.
    public override read(key: string): BunFile {
        const file = super.read(key);
        const stream = file.stream.bind(file);
        return Object.assign(file, {
            stream: () => {
                const gate = this.readGate;
                if (!gate) return stream();
                this.readGate = null;
                gate.parked();
                let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
                let cancelled = false;
                return new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        if (!reader) {
                            await gate.released;
                            if (cancelled) return;
                            reader = stream().getReader();
                        }
                        const { done, value } = await reader.read();
                        if (done) controller.close();
                        else controller.enqueue(value);
                    },
                    cancel: async () => {
                        cancelled = true;
                        await reader?.cancel();
                    },
                });
            },
        });
    }
}

// The rows of a document database, read inside one withDatabase call.
async function readItems(mount: Mount, config: DatabaseConfig<typeof docSchema>, dataDbId: string) {
    return mount.withDatabase(config, dataDbId, async (managed) => managed.db.select().from(docSchema.items).all());
}

const createdMounts: Mount[] = [];

async function createGatedLocalMount(id: string): Promise<{ mount: Mount; storage: GatedLocalStorage }> {
    const mount = new Mount(OWNER_ID, TEST_DIR, createTestMountConfig(id, 'local'), createGetLocalDatabase(TEST_DIR));
    const storage = new GatedLocalStorage(join(TEST_DIR, 'mounts', id));
    mount.storage = storage;
    await mount.init();
    createdMounts.push(mount);
    return { mount, storage };
}

// Row count in the on-storage copy of data.db at its CURRENT resolved key.
async function countStoredRows(mount: Mount, dataDbId: string): Promise<number | null> {
    return countRowsInFile(await mount.readFile(dataDbId), TEST_DIR);
}

async function provisionDoc(
    mount: Mount,
    config: DatabaseConfig<typeof docSchema>,
    containerType: 'doc' | 'chat' = 'doc',
): Promise<{ containerId: string; dataDbId: string; managed: ManagedDatabase<typeof docSchema> }> {
    const rootId = (await mount.getRootFolder())!.id;
    const containerId = await mount.createFolder(rootId, `container-${containerType}`, containerType);
    const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
    const managed = await mount.createDatabase(config, dataDbId);
    return { containerId, dataDbId, managed };
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

describe('open during close waits for the close to settle', () => {
    test("local: a reopen landing in the trash's close window rebuilds from storage; its sync succeeds", async () => {
        const { mount, storage } = await createGatedLocalMount('interleave-trash');
        const { containerId, dataDbId, managed } = await provisionDoc(mount, docConfig, 'chat');

        managed.db.insert(docSchema.items).values({ id: 1, data: 'synced' }).run();
        await managed.flush();
        managed.db.insert(docSchema.items).values({ id: 2, data: 'dirty' }).run(); // close's final sync writes this

        // A trash marks and renames first, then closes. Park that close's final sync (close → onSync →
        // uploadFromTemp → storage.write) and land an open in the window.
        await mount.trashPath(containerId);
        const writeGate = storage.armWrite();
        const closePromise = mount.closeDatabase(dataDbId, { skipFinalSnapshot: true });
        await writeGate.parked;

        const openPromise = mount.holdDatabase(docConfig, dataDbId);
        writeGate.release();

        const reopened = await openPromise; // pre-fix: adopts the closing instance's live temp
        await closePromise;

        // Pre-fix the old close's cleanupTemp unlinked the adopted temp: this flush throws
        // 'uploadFromTemp … tempfile missing' (steady-state sync loss until reopen). Post-fix
        // the open waited and rebuilt from storage — the write lands in .trash/ with the rest.
        reopened.db.db.insert(docSchema.items).values({ id: 3, data: 'post-reopen' }).run();
        await reopened.db.flush();
        reopened.release();

        expect(await countStoredRows(mount, dataDbId)).toBe(3);
        expect(mount.documentDbs.get(dataDbId)?.db).toBeDefined();
    }, 10_000);
});

describe('snapshot skip semantics (tick/close snapshots never park on the container lock)', () => {
    test("(i) a 'skipped' snapshot does not advance the watermark — the next tick retries it", async () => {
        // Pre-fix snapshotIfDue advanced unconditionally, recording the skip as taken; the
        // second onSnapshot call below then never happened.
        const calls: string[] = [];
        const second = deferred();
        const db = new ManagedDatabase(snapshotDocConfig, join(TEST_DIR, 'md-skip-advance.db'), {
            onSync: async () => {},
            onSnapshot: async () => {
                const result = calls.length === 0 ? ('skipped' as const) : ('taken' as const);
                calls.push(result);
                if (calls.length === 2) second.resolve();
                return result;
            },
        });
        await db.open(5); // 5ms ticks drive sync + snapshotIfDue
        db.db.insert(docSchema.items).values({ id: 1, data: 'x' }).run();

        const retried = await settlesWithin([second.promise], 3_000);
        await db.close({ skipFinalSnapshot: true }); // stops the tick timer on both outcomes
        expect(retried).toBe(true);
        expect(calls).toEqual(['skipped', 'taken']);
    }, 10_000);

    test('(ii) a contended close-path snapshot skips: close settles, the version entry is forgone', async () => {
        const { mount } = await createGatedLocalMount('snap-close-skip');
        const { containerId, dataDbId, managed } = await provisionDoc(mount, snapshotDocConfig);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'x' }).run();

        // Occupy the container lock for the whole close.
        const hold = deferred();
        const lockHeld = deferred();
        const holder = mount.withPathLock(containerId, async () => {
            lockHeld.resolve();
            await hold.promise;
        });
        await lockHeld.promise;

        // Pre-fix the close-time snapshot PARKED on the held lock (the H→F→C deadlock leg);
        // post-fix it skips and the close settles while the lock is still held — permanently
        // forgoing this one version entry, never bytes (the final sync already ran).
        const closed = await settlesWithin([mount.closeDatabase(dataDbId)], 3_000);
        hold.resolve();
        await holder;
        expect(closed).toBe(true);

        expect(await mount.getChildByName(containerId, 'versions')).toBeNull();
        expect(mount.documentDbs.has(dataDbId)).toBe(false);
    }, 10_000);

    test('(iii) a close-time snapshot that WINS the lock + a concurrent reopen: both settle', async () => {
        const { mount, storage } = await createGatedLocalMount('snap-close-reopen');
        const { containerId, dataDbId, managed } = await provisionDoc(mount, snapshotDocConfig);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'x' }).run(); // dirty → gated final sync

        const gate = storage.armWrite();
        const closePromise = mount.closeDatabase(dataDbId);
        await gate.parked;
        // The reopen lands mid-close and queues behind it. The close's own snapshot then wins the
        // (free) container lock; waiting on the slot there would wedge the pathId on its own close.
        const openPromise = readItems(mount, snapshotDocConfig, dataDbId);
        gate.release();

        const bothSettled = await settlesWithin([closePromise, openPromise], 4_000);
        // On the wedge, afterEach must not park on the wedged getter — drop the mount.
        if (!bothSettled) createdMounts.splice(createdMounts.indexOf(mount), 1);
        expect(bothSettled).toBe(true);

        // The snapshot was taken (it won the lock) and the reopen rebuilt from storage.
        const versions = await mount.getChildByName(containerId, 'versions');
        expect(versions).not.toBeNull();
        expect(await mount.listFolder(versions!.id)).toHaveLength(1);
        expect(await openPromise).toHaveLength(1);
        expect(mount.documentDbs.get(dataDbId)?.db).toBeDefined();
    }, 15_000);
});

describe('the sync tick of an open document', () => {
    afterEach(() => jest.useRealTimers());

    // The document with its 30 s sync timer on the fake clock, so a test fires the real tick itself.
    async function provisionDocWithTick(mount: Mount) {
        jest.useFakeTimers();
        const doc = await provisionDoc(mount, snapshotDocConfig);
        const fireTick = () => {
            jest.advanceTimersByTime(30_000);
            jest.useRealTimers();
        };
        return { ...doc, fireTick };
    }

    async function listVersions(mount: Mount, containerId: string) {
        const versions = await mount.getChildByName(containerId, VERSIONS_FOLDER_NAME);
        return versions ? mount.listFolder(versions.id) : [];
    }

    async function versionCount(mount: Mount, containerId: string): Promise<number> {
        return (await listVersions(mount, containerId)).length;
    }

    test('a write during its upload does not upload the document twice for the version it takes', async () => {
        const { mount, storage } = await createGatedLocalMount('tick-one-upload');
        const { containerId, dataDbId, managed, fireTick } = await provisionDocWithTick(mount);
        const key = await mount.getStorageKey(dataDbId);
        const writes = spyOn(storage, 'write');
        const gate = storage.armWrite();

        managed.db.insert(docSchema.items).values({ id: 1, data: 'synced' }).run();
        fireTick();
        await gate.parked;
        managed.db.insert(docSchema.items).values({ id: 2, data: 'during the upload' }).run();
        gate.release();

        const deadline = Date.now() + SETTLE_BOUND_MS;
        while ((await versionCount(mount, containerId)) === 0 && Date.now() < deadline) await Bun.sleep(5);
        // On a wedged tick, afterEach must not park on the close that waits for it.
        if ((await versionCount(mount, containerId)) === 0) createdMounts.splice(createdMounts.indexOf(mount), 1);
        expect(await versionCount(mount, containerId)).toBe(1);
        expect(writes.mock.calls.filter(([written]) => written === key)).toHaveLength(1);

        // The next sync, here the close's, stores the write the upload could not hold.
        await mount.closeDatabase(dataDbId);
        expect(await countStoredRows(mount, dataDbId)).toBe(2);

        // The version reads the live database, so it holds that write too.
        for (const version of await listVersions(mount, containerId)) {
            expect(await countRowsInFile(await mount.readFile(version.id), TEST_DIR)).toBe(2);
        }
    }, 15_000);

    test('a flush, a save and a reader that come during its snapshot all finish after it', async () => {
        const { mount, storage } = await createGatedLocalMount('tick-snapshot-waiters');
        const { containerId, dataDbId, managed, fireTick } = await provisionDocWithTick(mount);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'x' }).run();
        await managed.flush();

        // The database is clean, so the first write of the tick is the version's own.
        const gate = storage.armWrite();
        fireTick();
        await gate.parked;
        const waiters = [
            mount.flushContainerDb(containerId),
            mount.snapshotContainerDataDb(containerId, DEFAULT_RETENTION),
            readItems(mount, snapshotDocConfig, dataDbId),
        ];
        gate.release();

        const settled = await settlesWithin(waiters, SETTLE_BOUND_MS);
        if (!settled) createdMounts.splice(createdMounts.indexOf(mount), 1);
        expect(settled).toBe(true);
        expect(await versionCount(mount, containerId)).toBeGreaterThanOrEqual(1);
    }, 15_000);
});

describe('unchanged paths', () => {
    test('plain open/write/close/reopen round-trip stays intact', async () => {
        const { mount } = await createGatedLocalMount('plain-roundtrip');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);

        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        expect(mount.documentDbs.has(dataDbId)).toBe(false);

        await mount.withDatabase(docConfig, dataDbId, async (reopened) => {
            expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(1);
            reopened.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        });
        await mount.closeDatabase(dataDbId);
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    });

    test('crash-recovery adoption with NO registered close still works', async () => {
        const { mount } = await createGatedLocalMount('crash-adopt');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);

        managed.db.insert(docSchema.items).values({ id: 1, data: 'synced' }).run();
        await mount.closeDatabase(dataDbId);

        // Simulate a crash: rebuild the temp from the backing store, add an UNSYNCED row, and
        // leave it behind exactly as an unclean shutdown would — no close in flight, so the
        // open must NOT wait, and must adopt + markDirty as before.
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

        await mount.withDatabase(docConfig, dataDbId, async () => {});
        await mount.closeDatabase(dataDbId);

        // Without the adoption + markDirty, the reopened DB looked clean and row 2 was dropped.
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    });

    test('a close whose final sync fails leaves no handle behind; the next open adopts the temp', async () => {
        const { mount, storage } = await createGatedLocalMount('failed-close');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'unsynced' }).run();

        const gate = storage.armWrite();
        const closing = mount.closeDatabase(dataDbId);
        await gate.parked;
        gate.fail(new ApiError(503, 'storage unavailable'));
        await expect(closing).rejects.toThrow();
        expect(mount.documentDbs.has(dataDbId)).toBe(false);

        expect(await readItems(mount, docConfig, dataDbId)).toHaveLength(1);
    });

    test('a close whose final sync fails keeps the row on the size of the stored object', async () => {
        const { mount, storage } = await createGatedLocalMount('failed-close-size');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);
        const storedSize = await storage.size(await mount.getStorageKey(dataDbId));
        expect((await mount.getPath(dataDbId))!.size).toBe(storedSize!);
        for (let id = 1; id <= 200; id++) {
            managed.db
                .insert(docSchema.items)
                .values({ id, data: 'x'.repeat(400) })
                .run();
        }

        const gate = storage.armWrite();
        const closing = mount.closeDatabase(dataDbId);
        await gate.parked;
        gate.fail(new ApiError(503, 'storage unavailable'));
        await expect(closing).rejects.toThrow();

        expect(await storage.size(await mount.getStorageKey(dataDbId))).toBe(storedSize);
        expect((await mount.getPath(dataDbId))!.size).toBe(storedSize!);
    });

    test('a close whose final sync fails writes no version entry from the stale storage copy', async () => {
        const { mount, storage } = await createGatedLocalMount('failed-close-no-snapshot');
        const { containerId, dataDbId, managed } = await provisionDoc(mount, snapshotDocConfig);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'synced' }).run();
        await managed.flush(); // syncs without snapshotting
        managed.db.insert(docSchema.items).values({ id: 2, data: 'unsynced' }).run();
        expect(await mount.getChildByName(containerId, 'versions')).toBeNull();

        const gate = storage.armWrite();
        const closing = mount.closeDatabase(dataDbId);
        await gate.parked;
        gate.fail(new ApiError(503, 'storage unavailable'));
        await expect(closing).rejects.toThrow();

        // Pre-fix the close snapshotted the storage object: row 1 only, stamped now.
        expect(await mount.getChildByName(containerId, 'versions')).toBeNull();

        await mount.withDatabase(snapshotDocConfig, dataDbId, async () => {});
        await mount.closeDatabase(dataDbId);
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    });

    test('a create whose initial flush fails closes what it opened', async () => {
        const { mount, storage } = await createGatedLocalMount('failed-create-flush');
        const rootId = (await mount.getRootFolder())!.id;
        const containerId = await mount.createFolder(rootId, 'container-doc', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');

        // A sustained outage: the create's flush and the cleanup close's final sync both fail.
        storage.write = () => Promise.reject(new ApiError(503, 'storage unavailable'));
        await expect(mount.createDatabase(docConfig, dataDbId)).rejects.toThrow('storage unavailable');

        // Pre-fix the connection stayed open (30s timer, fd, -wal/-shm) with no slot pointing at it.
        const tempPath = mount.getTempPath(dataDbId);
        expect(mount.documentDbs.has(dataDbId)).toBe(false);
        expect(existsSync(`${tempPath}-wal`)).toBe(false);
        expect(existsSync(`${tempPath}-shm`)).toBe(false);
        expect(existsSync(tempPath)).toBe(true); // the failed close keeps it as the crash marker
        expect(await settlesWithin([mount.closeAllDatabases()], SETTLE_BOUND_MS)).toBe(true);
    });
});

describe('mount teardown', () => {
    test('an open queued behind a teardown close whose sync fails is refused; nothing outlives teardown', async () => {
        const { mount, storage } = await createGatedLocalMount('teardown-queued-open');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'unsynced' }).run();

        const gate = storage.armWrite();
        const teardown = mount.closeAllDatabases();
        await gate.parked;
        // Queues on the slot the sweep already visited; pre-fix it adopted the failed close's temp.
        const queued = mount
            .withDatabase(docConfig, dataDbId, async () => {})
            .then(
                () => null,
                (err: unknown) => err,
            );
        gate.fail(new ApiError(503, 'storage unavailable'));

        expect(await settlesWithin([teardown], SETTLE_BOUND_MS)).toBe(true);
        expect(await queued).toMatchObject({ status: 503 });
        expect(mount.documentDbs.size).toBe(0);
        expect(existsSync(mount.getTempPath(dataDbId))).toBe(true);
    }, 10_000);
});

describe('nested close during an in-flight close', () => {
    test('close → open → close chain settles; no slot is left behind; a third open syncs', async () => {
        const { mount, storage } = await createGatedLocalMount('nested-close');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);

        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run(); // dirty → close1's final sync writes

        const gate = storage.armWrite();
        const close1 = mount.closeDatabase(dataDbId);
        await gate.parked;

        const openPromise = mount.withDatabase(docConfig, dataDbId, async () => {}); // waits on close1
        const close2 = mount.closeDatabase(dataDbId); // nested: queues behind the open
        gate.release();

        await Promise.all([close1, openPromise, close2]);

        expect(mount.documentDbs.has(dataDbId)).toBe(false);

        await mount.withDatabase(docConfig, dataDbId, async (third) => {
            third.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
            await third.flush();
        });
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    }, 10_000);
});

describe('an open still loading from storage', () => {
    test('a close landing mid-load closes what the open built: no cached handle, no temp left', async () => {
        const { mount, storage } = await createGatedLocalMount('close-mid-load');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);

        const gate = storage.armRead();
        // The handle comes out of the call only to show that the close closed it.
        const openPromise = mount.withDatabase(docConfig, dataDbId, async (db) => db);
        try {
            await gate.parked;
            const closePromise = mount.closeDatabase(dataDbId);
            gate.release();
            const opened = await openPromise;
            await closePromise;

            expect(() => opened.db).toThrow('Database not open');
            expect(mount.documentDbs.has(dataDbId)).toBe(false);
            expect(existsSync(mount.getTempPath(dataDbId))).toBe(false);
            expect(await countStoredRows(mount, dataDbId)).toBe(1);
        } finally {
            gate.release();
        }
    }, 10_000);

    test('mount teardown settles while an open is parked on storage', async () => {
        const { mount, storage } = await createGatedLocalMount('teardown-mid-load');
        const { dataDbId } = await provisionDoc(mount, docConfig);
        await mount.closeDatabase(dataDbId);

        const gate = storage.armRead();
        const openPromise = mount.withDatabase(docConfig, dataDbId, async () => {}).catch(() => {});
        let teardown: Promise<void> | undefined;
        try {
            await gate.parked;
            teardown = mount.closeAllDatabases();
            expect(await settlesWithin([teardown], SETTLE_BOUND_MS)).toBe(true);
        } finally {
            gate.release();
            await teardown;
            await openPromise;
        }
    }, 10_000);

    // The abort fails the parked open while teardown is closing the doc ahead of it.
    test('mount teardown settles when an open it aborts fails during an earlier close', async () => {
        const { mount, storage } = await createGatedLocalMount('teardown-abort-mid-close');
        await provisionDoc(mount, docConfig, 'chat');
        const { dataDbId } = await provisionDoc(mount, docConfig);
        await mount.closeDatabase(dataDbId);

        const gate = storage.armRead();
        const failing = mount.withDatabase(docConfig, dataDbId, async () => {}).catch(() => {});
        await gate.parked;
        try {
            expect(await settlesWithin([mount.closeAllDatabases()], SETTLE_BOUND_MS)).toBe(true);
        } finally {
            gate.release();
            await failing;
        }
    }, 10_000);

    test("an open that fails after a close took its slot leaves the successor's cache entry alone", async () => {
        const { mount, storage } = await createGatedLocalMount('failed-open-successor');
        const { dataDbId } = await provisionDoc(mount, docConfig);
        await mount.closeDatabase(dataDbId);

        const gate = storage.armRead();
        const failing = mount.withDatabase(docConfig, dataDbId, async () => {}).catch(() => {});
        await gate.parked;
        // The close and the successor open queue behind the parked open.
        const closing = mount.closeDatabase(dataDbId).catch(() => {});
        const successor = mount.holdDatabase(docConfig, dataDbId);
        gate.fail(new ApiError(503, 'storage unavailable'));
        await Promise.all([failing, closing]);

        const reopened = await successor;
        const cached = mount.documentDbs.has(dataDbId);
        reopened.release();
        if (!cached) await reopened.db.close();
        expect(cached).toBe(true);
    }, 10_000);

    test('two concurrent opens of one pathId build once and share the instance', async () => {
        const { mount, storage } = await createGatedLocalMount('concurrent-opens');
        const { dataDbId } = await provisionDoc(mount, docConfig);
        await mount.closeDatabase(dataDbId);

        const gate = storage.armRead();
        const first = mount.holdDatabase(docConfig, dataDbId);
        await gate.parked;
        const second = mount.holdDatabase(docConfig, dataDbId);
        gate.release();

        const [a, b] = await Promise.all([first, second]);
        a.release();
        b.release();
        expect(a.db).toBe(b.db);
    }, 10_000);

    test('a blocking snapshot landing during an in-flight open waits for the open to land', async () => {
        const { mount, storage } = await createGatedLocalMount('snap-mid-load');
        const { containerId, dataDbId } = await provisionDoc(mount, docConfig);
        await mount.closeDatabase(dataDbId);

        const gate = storage.armRead();
        const order: string[] = [];
        const openPromise = mount.holdDatabase(docConfig, dataDbId).then((hold) => {
            order.push('open');
            hold.release();
        });
        try {
            await gate.parked;
            // The manual-save path: it must flush what the open builds, not copy storage around it.
            const snapshotPromise = mount
                .snapshotContainerDataDb(containerId, DEFAULT_RETENTION)
                .then(() => order.push('snapshot'));
            const landedEarly = await settlesWithin([snapshotPromise], STALL_BOUND_MS);
            gate.release();
            await Promise.all([openPromise, snapshotPromise]);

            expect(landedEarly).toBe(false);
            expect(order).toEqual(['open', 'snapshot']);
            const versions = await mount.getChildByName(containerId, 'versions');
            expect(await mount.listFolder(versions!.id)).toHaveLength(1);
        } finally {
            gate.release();
        }
    }, 10_000);

    test('an open that fails leaves no slot behind', async () => {
        const { mount, storage } = await createGatedLocalMount('failed-open-no-slot');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);

        const gate = storage.armRead();
        const failing = mount.withDatabase(docConfig, dataDbId, async () => {});
        await gate.parked;
        gate.fail(new ApiError(503, 'storage unavailable'));
        await expect(failing).rejects.toThrow();
        expect(mount.documentDbs.has(dataDbId)).toBe(false);

        expect(await readItems(mount, docConfig, dataDbId)).toHaveLength(1);
    }, 10_000);
});

// A reader holds its database only while it runs. The database then closes after IDLE_CLOSE_MS, and
// a close that comes earlier waits for the holder, for a few seconds at most.
describe('holders', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('a database a reader used closes IDLE_CLOSE_MS after it lets go', async () => {
        const { mount } = await createGatedLocalMount('idle-close');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);
        jest.useFakeTimers();

        await mount.withDatabase(docConfig, dataDbId, async (db) => {
            db.db.insert(docSchema.items).values({ id: 1, data: 'read then written' }).run();
        });
        const slot = mount.documentDbs.get(dataDbId);
        jest.advanceTimersByTime(IDLE_CLOSE_MS - 1);
        await slot?.tail;
        expect(slot?.db).toBe(managed);

        jest.advanceTimersByTime(1);
        await slot?.tail;
        expect(slot?.db).toBeNull();
        expect(() => managed.db).toThrow('Database not open');
        // The close synced the write.
        expect(await countStoredRows(mount, dataDbId)).toBe(1);
    });

    test('a reader that comes back within the idle window keeps the database open', async () => {
        const { mount } = await createGatedLocalMount('idle-renewed');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);
        jest.useFakeTimers();

        await mount.withDatabase(docConfig, dataDbId, async () => {});
        jest.advanceTimersByTime(IDLE_CLOSE_MS / 2);
        await mount.withDatabase(docConfig, dataDbId, async () => {});
        const slot = mount.documentDbs.get(dataDbId);
        jest.advanceTimersByTime(IDLE_CLOSE_MS - 1);
        await slot?.tail;
        expect(slot?.db).toBe(managed);

        jest.advanceTimersByTime(1);
        await slot?.tail;
        expect(slot?.db).toBeNull();
    });

    test('a second release of one hold lets go of nothing', async () => {
        const { mount } = await createGatedLocalMount('release-twice');
        const { dataDbId } = await provisionDoc(mount, docConfig);
        const first = await mount.holdDatabase(docConfig, dataDbId);
        const second = await mount.holdDatabase(docConfig, dataDbId);
        const slot = mount.documentDbs.get(dataDbId);

        first.release();
        first.release();
        expect(slot?.holders).toBe(1);
        expect(slot?.idleTimer).toBeNull();

        second.release();
        expect(slot?.holders).toBe(0);
        expect(slot?.idleTimer).not.toBeNull();
    });

    test('a close waits for a reader in flight, which reads the open database', async () => {
        const { mount } = await createGatedLocalMount('close-waits-holder');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();

        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const reading = mount.withDatabase(docConfig, dataDbId, async (db) => {
            entered.resolve();
            await gate.promise;
            return db.db.select().from(docSchema.items).all().length;
        });
        await entered.promise;

        const closing = mount.closeDatabase(dataDbId);
        expect(await settlesWithin([closing], STALL_BOUND_MS)).toBe(false);
        gate.resolve();
        expect(await reading).toBe(1);
        await closing;
        expect(mount.documentDbs.has(dataDbId)).toBe(false);
    });

    test('a close waiting for a holder that never lets go closes after HOLDER_WAIT_MS', async () => {
        const { mount } = await createGatedLocalMount('close-deadline');
        const { dataDbId } = await provisionDoc(mount, docConfig);
        const hold = await mount.holdDatabase(docConfig, dataDbId);
        const slot = mount.documentDbs.get(dataDbId);
        jest.useFakeTimers();

        const closing = mount.closeDatabase(dataDbId);
        // A few microtasks bring the close to its wait.
        for (let turn = 0; turn < 100 && !slot?.lastHolderGone; turn++) await Promise.resolve();
        expect(slot?.lastHolderGone).toBeTruthy();
        jest.advanceTimersByTime(HOLDER_WAIT_MS - 1);
        expect(slot?.db).not.toBeNull();

        jest.advanceTimersByTime(1);
        await closing;
        expect(slot?.db).toBeNull();
        expect(() => hold.db.db).toThrow('Database not open');
        // A late release after the forced close arms nothing.
        hold.release();
        expect(slot?.idleTimer).toBeNull();
    });

    test('a holder the forced close left behind does not count against the database opened after it', async () => {
        const { mount } = await createGatedLocalMount('close-deadline-reopen');
        const { dataDbId } = await provisionDoc(mount, docConfig);
        const stale = await mount.holdDatabase(docConfig, dataDbId);
        const slot = mount.documentDbs.get(dataDbId);
        jest.useFakeTimers();

        const closing = mount.closeDatabase(dataDbId);
        const reopening = mount.holdDatabase(docConfig, dataDbId);
        for (let turn = 0; turn < 100 && !slot?.lastHolderGone; turn++) await Promise.resolve();
        jest.advanceTimersByTime(HOLDER_WAIT_MS);
        await closing;
        const fresh = await reopening;
        expect(mount.documentDbs.get(dataDbId)).toBe(slot);
        expect(slot?.holders).toBe(1);

        fresh.release();
        expect(slot?.holders).toBe(0);
        expect(slot?.idleTimer).not.toBeNull();
        // The stale holder lets go of the database the close took away, not of the new one.
        stale.release();
        expect(slot?.holders).toBe(0);
    });
});
