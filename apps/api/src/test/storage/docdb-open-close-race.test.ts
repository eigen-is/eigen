import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { BunFile } from 'bun';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { ApiError, type DatabaseConfig, ManagedDatabase } from '../../lib/core';
import { Mount } from '../../lib/mount/mount';
import { LocalStorage } from '../../lib/storage/local-storage';
import { DEFAULT_RETENTION } from '../../lib/versioning/retention';
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

// LocalStorage whose next write()/rename() after arm parks on a test-controlled gate (a write can
// also be failed) — freezes a close mid-final-sync (or a trash mid-rename) so a concurrent open
// lands deterministically in the close window. One-shot: the arm is consumed synchronously at park time, so every other
// call passes straight through. No sleeps anywhere — pure deferreds.
class GatedLocalStorage extends LocalStorage {
    private writeGate: { parked: () => void; released: Promise<void> } | null = null;
    private renameGate: { parked: () => void; released: Promise<void> } | null = null;
    private readGate: { parked: () => void; released: Promise<void> } | null = null;

    armWrite(): Gate & { fail: (err: Error) => void } {
        const parked = deferred();
        const released = Promise.withResolvers<void>();
        this.writeGate = { parked: parked.resolve, released: released.promise };
        return { parked: parked.promise, release: released.resolve, fail: released.reject };
    }

    armRename(): Gate {
        const parked = deferred();
        const released = deferred();
        this.renameGate = { parked: parked.resolve, released: released.promise };
        return { parked: parked.promise, release: released.resolve };
    }

    // Parks the next download before its first byte, holding the open mid-load like a stalled GET.
    armRead(): Gate & { fail: (err: Error) => void } {
        const parked = deferred();
        const released = Promise.withResolvers<void>();
        this.readGate = { parked: parked.resolve, released: released.promise };
        return { parked: parked.promise, release: released.resolve, fail: released.reject };
    }

    override async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const gate = this.writeGate;
        if (gate) {
            this.writeGate = null;
            gate.parked();
            await gate.released;
        }
        return super.write(key, data);
    }

    override async rename(oldKey: string, newKey: string): Promise<void> {
        const gate = this.renameGate;
        if (gate) {
            this.renameGate = null;
            gate.parked();
            await gate.released;
        }
        return super.rename(oldKey, newKey);
    }

    // Gated at stream() rather than read(): exists() and size() read the same handle.
    override read(key: string): BunFile {
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
    test("local: a reopen landing in trashPath's close window rebuilds from storage; its sync succeeds", async () => {
        const { mount, storage } = await createGatedLocalMount('interleave-trash');
        const { containerId, dataDbId, managed } = await provisionDoc(mount, docConfig, 'chat');

        managed.db.insert(docSchema.items).values({ id: 1, data: 'synced' }).run();
        await managed.flush();
        managed.db.insert(docSchema.items).values({ id: 2, data: 'dirty' }).run(); // close's final sync writes this

        // Park the close's final sync (trashPath → closeCachedDbsUnder → close → onSync →
        // uploadFromTemp → storage.write) and land an open in the window. Keys resolve under the tree lock, so
        // the assertion holds whether the open takes it before the trash's rename (its sync resolves the trashed key) or after.
        const writeGate = storage.armWrite();
        const trashPromise = mount.trashPath(containerId);
        await writeGate.parked;

        const openPromise = mount.openDatabase(docConfig, dataDbId);
        const renameGate = storage.armRename();
        writeGate.release();
        await renameGate.parked;
        renameGate.release();

        const reopened = await openPromise; // pre-fix: adopts the closing instance's live temp
        await trashPromise;

        // Pre-fix the old close's cleanupTemp unlinked the adopted temp: this flush throws
        // 'uploadFromTemp … tempfile missing' (steady-state sync loss until reopen). Post-fix
        // the open waited and rebuilt from storage — the write lands in .trash/ with the rest.
        reopened.db.insert(docSchema.items).values({ id: 3, data: 'post-reopen' }).run();
        await reopened.flush();

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
        const openPromise = mount.openDatabase(snapshotDocConfig, dataDbId);
        gate.release();

        const bothSettled = await settlesWithin([closePromise, openPromise], 4_000);
        // On the wedge, afterEach must not park on the wedged getter — drop the mount.
        if (!bothSettled) createdMounts.splice(createdMounts.indexOf(mount), 1);
        expect(bothSettled).toBe(true);

        // The snapshot was taken (it won the lock) and the reopen rebuilt from storage.
        const versions = await mount.getChildByName(containerId, 'versions');
        expect(versions).not.toBeNull();
        expect(await mount.listFolder(versions!.id)).toHaveLength(1);
        const reopened = await openPromise;
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(1);
        expect(mount.documentDbs.get(dataDbId)?.db).toBeDefined();
    }, 15_000);
});

describe('unchanged paths', () => {
    test('plain open/write/close/reopen round-trip stays intact', async () => {
        const { mount } = await createGatedLocalMount('plain-roundtrip');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);

        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        expect(mount.documentDbs.has(dataDbId)).toBe(false);

        const reopened = await mount.openDatabase(docConfig, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(1);
        reopened.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await mount.closeDatabase(dataDbId);
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    });

    test('crash-recovery adoption with NO registered close still works (Phase 1a)', async () => {
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

        await mount.openDatabase(docConfig, dataDbId);
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

        const reopened = await mount.openDatabase(docConfig, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(1);
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

        await mount.openDatabase(snapshotDocConfig, dataDbId);
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
        const queued = mount.openDatabase(docConfig, dataDbId).then(
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

        const openPromise = mount.openDatabase(docConfig, dataDbId); // waits on close1
        const close2 = mount.closeDatabase(dataDbId); // nested: queues behind the open
        gate.release();

        await Promise.all([close1, openPromise, close2]);

        expect(mount.documentDbs.has(dataDbId)).toBe(false);

        const third = await mount.openDatabase(docConfig, dataDbId);
        third.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await third.flush();
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
        const openPromise = mount.openDatabase(docConfig, dataDbId);
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
        const openPromise = mount.openDatabase(docConfig, dataDbId).catch(() => null);
        let teardown: Promise<void> | undefined;
        try {
            await gate.parked;
            teardown = mount.closeAllDatabases();
            expect(await settlesWithin([teardown], SETTLE_BOUND_MS)).toBe(true);
        } finally {
            gate.release();
            await teardown;
            await (await openPromise)?.close();
        }
    }, 10_000);

    // The abort fails the parked open while teardown is closing the doc ahead of it.
    test('mount teardown settles when an open it aborts fails during an earlier close', async () => {
        const { mount, storage } = await createGatedLocalMount('teardown-abort-mid-close');
        await provisionDoc(mount, docConfig, 'chat');
        const { dataDbId } = await provisionDoc(mount, docConfig);
        await mount.closeDatabase(dataDbId);

        const gate = storage.armRead();
        const failing = mount.openDatabase(docConfig, dataDbId).catch(() => null);
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
        const failing = mount.openDatabase(docConfig, dataDbId).catch(() => null);
        await gate.parked;
        // The close and the successor open queue behind the parked open.
        const closing = mount.closeDatabase(dataDbId).catch(() => {});
        const successor = mount.openDatabase(docConfig, dataDbId);
        gate.fail(new ApiError(503, 'storage unavailable'));
        await Promise.all([failing, closing]);

        const reopened = await successor;
        const cached = mount.documentDbs.has(dataDbId);
        if (!cached) await reopened.close();
        expect(cached).toBe(true);
    }, 10_000);

    test('two concurrent opens of one pathId build once and share the instance', async () => {
        const { mount, storage } = await createGatedLocalMount('concurrent-opens');
        const { dataDbId } = await provisionDoc(mount, docConfig);
        await mount.closeDatabase(dataDbId);

        const gate = storage.armRead();
        const first = mount.openDatabase(docConfig, dataDbId);
        await gate.parked;
        const second = mount.openDatabase(docConfig, dataDbId);
        gate.release();

        const [a, b] = await Promise.all([first, second]);
        expect(a).toBe(b);
    }, 10_000);

    test('a blocking snapshot landing during an in-flight open waits for the open to land', async () => {
        const { mount, storage } = await createGatedLocalMount('snap-mid-load');
        const { containerId, dataDbId } = await provisionDoc(mount, docConfig);
        await mount.closeDatabase(dataDbId);

        const gate = storage.armRead();
        const order: string[] = [];
        const openPromise = mount.openDatabase(docConfig, dataDbId).then((db) => {
            order.push('open');
            return db;
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
        const failing = mount.openDatabase(docConfig, dataDbId);
        await gate.parked;
        gate.fail(new ApiError(503, 'storage unavailable'));
        await expect(failing).rejects.toThrow();
        expect(mount.documentDbs.has(dataDbId)).toBe(false);

        const reopened = await mount.openDatabase(docConfig, dataDbId);
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(1);
    }, 10_000);
});
