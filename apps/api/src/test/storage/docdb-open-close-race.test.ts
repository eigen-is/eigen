import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { BunFile } from 'bun';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { type DatabaseConfig, ManagedDatabase } from '../../lib/core';
import { createDefaultMountConfig } from '../../lib/mount/helpers';
import { Mount } from '../../lib/mount/mount';
import type { StorageBackend } from '../../lib/storage';
import { LocalStorage } from '../../lib/storage/local-storage';
import { DEFAULT_RETENTION } from '../../lib/versioning/retention';
import { createGetLocalDatabase } from '../fault-storage-helpers';

// Regression net for AUDIT_STORAGE item 4 (design note 2026-07-05): an openDatabase landing in
// closeDatabase's async close window built a fresh ManagedDatabase over the closing instance's
// live files — on `local` it adopted the doomed temp as crash recovery, and the old close's
// cleanupTemp then unlinked it under the adopted connection (every later sync throws
// 'tempfile missing' until reopen — the tail is lost). The fix: opens wait on
// mount.closingDocumentDbs, tick/close snapshots skip when the container lock is contended
// (never park — the H→F→C deadlock), and snapshot reads peek() the documentDbs getter instead
// of awaiting an unresolved factory (the C→F→C wedge).

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

// LocalStorage whose next write()/rename() after arm parks on a test-controlled gate — freezes a
// close mid-final-sync (or a trash mid-rename) so a concurrent open lands deterministically in
// the close window. One-shot: the arm is consumed synchronously at park time, so every other
// call passes straight through. No sleeps anywhere — pure deferreds.
class GatedLocalStorage extends LocalStorage {
    private writeGate: { parked: () => void; released: Promise<void> } | null = null;
    private renameGate: { parked: () => void; released: Promise<void> } | null = null;

    armWrite(): Gate {
        const parked = deferred();
        const released = deferred();
        this.writeGate = { parked: parked.resolve, released: released.promise };
        return { parked: parked.promise, release: released.resolve };
    }

    armRename(): Gate {
        const parked = deferred();
        const released = deferred();
        this.renameGate = { parked: parked.resolve, released: released.promise };
        return { parked: parked.promise, release: released.resolve };
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
}

const createdMounts: Mount[] = [];

async function createGatedLocalMount(id: string): Promise<{ mount: Mount; storage: GatedLocalStorage }> {
    const mount = new Mount(
        OWNER_ID,
        TEST_DIR,
        createDefaultMountConfig(id, 'local'),
        createGetLocalDatabase(TEST_DIR),
    );
    const storage = new GatedLocalStorage(join(TEST_DIR, 'mounts', id));
    (mount as unknown as { storage: StorageBackend }).storage = storage;
    await mount.init();
    createdMounts.push(mount);
    return { mount, storage };
}

// Row count in the on-storage copy of data.db at its CURRENT resolved key.
async function countStoredRows(mount: Mount, dataDbId: string): Promise<number | null> {
    const file = await mount.readFile(dataDbId);
    if (!file) return null;
    const verifyPath = join(TEST_DIR, `verify-${Math.random().toString(36).slice(2)}.db`);
    await Bun.write(verifyPath, await file.arrayBuffer());
    const verify = new Database(verifyPath);
    const row = verify.query('SELECT COUNT(*) as c FROM items').get() as { c: number };
    verify.close();
    rmSync(verifyPath, { force: true });
    return row.c;
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

// Bounded deadlock detector — NOT synchronization: on the green path the promises settle
// immediately and the timer is cleared; only a genuine wedge runs it out. A rejection
// propagates to the caller like a plain await would.
async function settlesWithin(promises: Promise<unknown>[], ms: number): Promise<boolean> {
    let timer: Timer | undefined;
    try {
        return await Promise.race([
            Promise.all(promises).then(() => true),
            new Promise<boolean>((r) => {
                timer = setTimeout(() => r(false), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
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

describe('open during close waits for the close to settle', () => {
    test("local: a reopen landing in trashPath's close window rebuilds from storage; its sync succeeds", async () => {
        const { mount, storage } = await createGatedLocalMount('interleave-trash');
        const { containerId, dataDbId, managed } = await provisionDoc(mount, docConfig, 'chat');

        managed.db.insert(docSchema.items).values({ id: 1, data: 'synced' }).run();
        await managed.flush();
        managed.db.insert(docSchema.items).values({ id: 2, data: 'dirty' }).run(); // close's final sync writes this

        // Park the close's final sync (trashPath → closeCachedDbsUnder → close → onSync →
        // uploadFromTemp → storage.write) and land an open in the window. The rename gate keeps
        // the post-close rebuild reading the pre-trash location deterministically (open-vs-trash
        // row racing is a separate, pre-existing story).
        const writeGate = storage.armWrite();
        const trashPromise = mount.trashPath(containerId);
        await writeGate.parked;

        const openPromise = mount.openDatabase(docConfig, dataDbId);
        const renameGate = storage.armRename();
        writeGate.release();

        const reopened = await openPromise; // pre-fix: adopts the closing instance's live temp
        renameGate.release();
        await trashPromise;

        // Pre-fix the old close's cleanupTemp unlinked the adopted temp: this flush throws
        // 'uploadFromTemp … tempfile missing' (steady-state sync loss until reopen). Post-fix
        // the open waited and rebuilt from storage — the write lands in .trash/ with the rest.
        reopened.db.insert(docSchema.items).values({ id: 3, data: 'post-reopen' }).run();
        await reopened.flush();

        expect(await countStoredRows(mount, dataDbId)).toBe(3);
        expect(mount.closingDocumentDbs.size).toBe(0);
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
        expect(mount.closingDocumentDbs.size).toBe(0);
    }, 10_000);

    test('(iii) a close-time snapshot that WINS the lock + a concurrent reopen: both settle', async () => {
        const { mount, storage } = await createGatedLocalMount('snap-close-reopen');
        const { containerId, dataDbId, managed } = await provisionDoc(mount, snapshotDocConfig);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'x' }).run(); // dirty → gated final sync

        const gate = storage.armWrite();
        const closePromise = mount.closeDatabase(dataDbId);
        await gate.parked;
        // The reopen lands mid-close: its factory awaits the closing deferred. The close's own
        // snapshot then wins the (free) container lock, and its flush/stage step finds THIS
        // unresolved factory in documentDbs — awaiting it instead of peek()ing it wedges the
        // pathId permanently (C→F→C: the deferred never resolves).
        const openPromise = mount.openDatabase(snapshotDocConfig, dataDbId);
        gate.release();

        const bothSettled = await settlesWithin([closePromise, openPromise], 4_000);
        // On the wedge, afterEach must not park on the wedged getter — drop the mount.
        if (!bothSettled) createdMounts.splice(createdMounts.indexOf(mount), 1);
        expect(bothSettled).toBe(true);

        // The snapshot was taken (it won the lock), the reopen rebuilt from storage, and the
        // closing registry drained.
        const versions = await mount.getChildByName(containerId, 'versions');
        expect(versions).not.toBeNull();
        expect(await mount.listFolder(versions!.id)).toHaveLength(1);
        const reopened = await openPromise;
        expect(reopened.db.select().from(docSchema.items).all()).toHaveLength(1);
        expect(mount.closingDocumentDbs.size).toBe(0);
    }, 15_000);
});

describe('unchanged paths', () => {
    test('plain open/write/close/reopen round-trip stays intact', async () => {
        const { mount } = await createGatedLocalMount('plain-roundtrip');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);

        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();
        await mount.closeDatabase(dataDbId);
        expect(mount.closingDocumentDbs.size).toBe(0);

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
});

describe('nested close during an in-flight close', () => {
    test('close → open → close chain settles; a third open syncs; closing registry ends empty', async () => {
        const { mount, storage } = await createGatedLocalMount('nested-close');
        const { dataDbId, managed } = await provisionDoc(mount, docConfig);

        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run(); // dirty → close1's final sync writes

        const gate = storage.armWrite();
        const close1 = mount.closeDatabase(dataDbId);
        await gate.parked;

        const openPromise = mount.openDatabase(docConfig, dataDbId); // waits on close1
        const close2 = mount.closeDatabase(dataDbId); // nested: overwrites the closing slot
        gate.release();

        await Promise.all([close1, openPromise, close2]);

        // Identity-guarded delete: close1's finally must not clobber close2's registration, and
        // close2's own settle must leave the registry empty.
        expect(mount.closingDocumentDbs.size).toBe(0);

        const third = await mount.openDatabase(docConfig, dataDbId);
        third.db.insert(docSchema.items).values({ id: 2, data: 'b' }).run();
        await third.flush();
        expect(await countStoredRows(mount, dataDbId)).toBe(2);
    }, 10_000);
});
