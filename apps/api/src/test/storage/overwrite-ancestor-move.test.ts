import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BunFile } from 'bun';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DatabaseConfig } from '../../lib/core';
import { Mount } from '../../lib/mount/mount';
import { writeTempWithHash } from '../../lib/storage';
import { LocalStorage } from '../../lib/storage/local-storage';
import { createGetLocalDatabase, settlesWithin } from '../fault-storage-helpers';
import { createTestMountConfig } from '../mount-test-helpers';

// On `local` a key is its folder path: a key-derived write racing an ancestor rename, trash or a
// delete must land at the key the row ends up with, never rebuild the old tree.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-overwrite-ancestor-move-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

const docSchema = {
    items: sqliteTable('items', { id: integer('id').primaryKey(), data: text('data') }),
};
const docConfig: DatabaseConfig<typeof docSchema> = {
    name: 'ancestor-move-doc',
    currentVersion: 1,
    schema: docSchema,
    migrations: [{ version: 1, up: (db) => db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, data TEXT)') }],
};

type Gate = { parked: Promise<void>; release: () => void };

// LocalStorage whose next write or rename after arm parks until the test releases it. `order`
// records the storage calls that completed since the last arm.
class GatedLocalStorage extends LocalStorage {
    order: string[] = [];
    private writeGate: { parked: () => void; released: Promise<void> } | null = null;
    private renameGate: { parked: () => void; released: Promise<void> } | null = null;

    armWrite(): Gate {
        const parked = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        this.writeGate = { parked: parked.resolve, released: released.promise };
        this.order = [];
        return { parked: parked.promise, release: released.resolve };
    }

    armRename(): Gate {
        const parked = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        this.renameGate = { parked: parked.resolve, released: released.promise };
        this.order = [];
        return { parked: parked.promise, release: released.resolve };
    }

    override async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const gate = this.writeGate;
        if (gate) {
            this.writeGate = null;
            gate.parked();
            await gate.released;
        }
        const written = await super.write(key, data);
        this.order.push('write');
        return written;
    }

    override async rename(oldKey: string, newKey: string): Promise<void> {
        const gate = this.renameGate;
        if (gate) {
            this.renameGate = null;
            gate.parked();
            await gate.released;
        }
        await super.rename(oldKey, newKey);
        this.order.push('rename');
    }

    override async delete(key: string): Promise<boolean> {
        const deleted = await super.delete(key);
        this.order.push('delete');
        return deleted;
    }

    override async deleteDir(key: string): Promise<boolean> {
        const deleted = await super.deleteDir(key);
        this.order.push('deleteDir');
        return deleted;
    }
}

// armTreeWait resolves once the next tree-lock request queues behind a holder or, granted at once,
// has run its body: a parked storage call resumes only after the racer had every chance to overtake it.
// `granted` relies on RWLock invoking the body synchronously on an immediate grant.
class ProbeMount extends Mount {
    private treeWait: PromiseWithResolvers<void> | null = null;

    armTreeWait(): Promise<void> {
        this.treeWait = Promise.withResolvers<void>();
        return this.treeWait.promise;
    }

    override async withTreeShared<T>(fn: () => Promise<T>): Promise<T> {
        return this.probe((body) => super.withTreeShared(body), fn);
    }

    override async withTreeExclusive<T>(fn: () => Promise<T>): Promise<T> {
        return this.probe((body) => super.withTreeExclusive(body), fn);
    }

    private async probe<T>(acquire: (body: () => Promise<T>) => Promise<T>, fn: () => Promise<T>): Promise<T> {
        const wait = this.treeWait;
        this.treeWait = null;
        let granted = false;
        const run = acquire(() => {
            granted = true;
            return fn();
        });
        if (!granted) wait?.resolve();
        try {
            return await run;
        } finally {
            wait?.resolve();
        }
    }
}

const createdMounts: Mount[] = [];

function sha256(content: string): string {
    return new Bun.CryptoHasher('sha256').update(content).digest('hex');
}

async function fileInFolder(id: string) {
    const mount = new ProbeMount(
        OWNER_ID,
        TEST_DIR,
        createTestMountConfig(id, 'local'),
        createGetLocalDatabase(TEST_DIR),
    );
    const storage = new GatedLocalStorage(join(TEST_DIR, 'mounts', id));
    mount.storage = storage;
    await mount.init();
    createdMounts.push(mount);
    const rootId = (await mount.getRootFolder())!.id;
    const folderId = await mount.createFolder(rootId, 'before');
    const fileId = await mount.createFile(folderId, 'notes.txt', 'text/plain', 2, Buffer.from('v0'));
    const oldKey = await mount.getStorageKey(fileId);
    return { mount, storage, folderId, fileId, oldKey };
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

// The tree lock: a key-derived write holds the shared side from resolve through its row write, an
// ancestor rename, trash or folder delete the exclusive side, so the move waits for the write.
describe('a key-derived write racing an ancestor move on a path-based mount', () => {
    test('a parent renamed during the write leaves the bytes at the new key only', async () => {
        const { mount, storage, folderId, fileId, oldKey } = await fileInFolder('ancestor-rename');
        const gate = storage.armWrite();
        const write = mount.writeFile(fileId, Buffer.from('v1'));
        await gate.parked;
        const waiting = mount.armTreeWait();
        const move = mount.updatePath(folderId, { name: 'after' });
        await waiting;
        gate.release();
        await Promise.all([write, move]);

        const newKey = await mount.getStorageKey(fileId);
        expect(newKey).not.toBe(oldKey);
        expect(await storage.read(newKey).text()).toBe('v1');
        expect(await storage.exists(oldKey)).toBe(false);
        expect(existsSync(storage.getPath('before'))).toBe(false);
        expect(storage.order).toEqual(['write', 'rename']);
    });

    test('a parent trashed during the write leaves the bytes at the trashed key only', async () => {
        const { mount, storage, folderId, fileId, oldKey } = await fileInFolder('ancestor-trash');
        const gate = storage.armWrite();
        const write = mount.writeFile(fileId, Buffer.from('v1'));
        await gate.parked;
        const waiting = mount.armTreeWait();
        const trash = mount.trashPath(folderId);
        await waiting;
        gate.release();
        await Promise.all([write, trash]);

        const newKey = await mount.getStorageKey(fileId);
        expect(newKey).not.toBe(oldKey);
        expect(await storage.read(newKey).text()).toBe('v1');
        expect(await storage.exists(oldKey)).toBe(false);
        expect(existsSync(storage.getPath('before'))).toBe(false);
        expect(storage.order).toEqual(['write', 'rename']);
        expect(await mount.getPath(fileId)).toMatchObject({ size: 2, hash: sha256('v1') });
    });

    test.each([
        ['a save', true],
        ['a plain overwrite', false],
    ])('%s queued behind its folder trash refuses and leaves the trashed bytes', async (_, guarded) => {
        const { mount, storage, folderId, fileId } = await fileInFolder(`behind-trash-${guarded}`);
        const base = guarded ? (await mount.getPath(fileId))!.updatedAt : undefined;
        const hold = Promise.withResolvers<void>();
        const held = mount.withTreeShared(() => hold.promise);
        const trashQueued = mount.armTreeWait();
        const trash = mount.trashPath(folderId);
        await trashQueued;
        const saveQueued = mount.armTreeWait();
        const save = mount.writeFile(fileId, Buffer.from('v1'), base);
        await saveQueued;
        hold.resolve();
        await Promise.all([held, trash]);

        await expect(save).rejects.toMatchObject({ status: 404, message: 'File is in trash' });
        expect(await storage.read(await mount.getStorageKey(fileId)).text()).toBe('v0');
        expect(await mount.getPath(fileId)).toMatchObject({ size: 2, hash: sha256('v0') });
    });

    test('a file created under a folder renamed mid-write lands under the new name', async () => {
        const { mount, storage, folderId } = await fileInFolder('create-under-rename');
        const gate = storage.armWrite();
        const create = mount.createFile(folderId, 'new.txt', 'text/plain', 2, Buffer.from('v1'));
        await gate.parked;
        const waiting = mount.armTreeWait();
        const move = mount.updatePath(folderId, { name: 'after' });
        await waiting;
        gate.release();
        const [createdId] = await Promise.all([create, move]);

        const key = await mount.getStorageKey(createdId);
        expect(key.startsWith('after/')).toBe(true);
        expect(await storage.read(key).text()).toBe('v1');
        expect(existsSync(storage.getPath('before'))).toBe(false);
        expect(storage.order).toEqual(['write', 'rename']);
    });

    test("a managed db synced while its container's parent renames lands under the new name", async () => {
        const { mount, storage, folderId } = await fileInFolder('sync-under-rename');
        const containerId = await mount.createFolder(folderId, 'container', 'doc');
        const dataDbId = await mount.touchFile(containerId, 'data.db', 'application/x-sqlite3');
        const managed = await mount.createDatabase(docConfig, dataDbId);
        managed.db.insert(docSchema.items).values({ id: 1, data: 'a' }).run();

        const gate = storage.armWrite();
        const sync = managed.flush();
        await gate.parked;
        const waiting = mount.armTreeWait();
        const move = mount.updatePath(folderId, { name: 'after' });
        await waiting;
        gate.release();
        await Promise.all([sync, move]);

        const dataDbPath = storage.getPath(await mount.getStorageKey(dataDbId));
        expect(existsSync(dataDbPath)).toBe(true);
        expect(dataDbPath.startsWith(`${storage.getPath('after')}/`)).toBe(true);
        expect(existsSync(storage.getPath('before'))).toBe(false);
        expect(storage.order).toEqual(['write', 'rename']);
        await mount.closeDatabase(dataDbId);
    });

    test('a file deleted while its parent renames leaves no bytes at either key', async () => {
        const { mount, storage, folderId, fileId } = await fileInFolder('delete-under-rename');
        const gate = storage.armRename();
        const move = mount.updatePath(folderId, { name: 'after' });
        await gate.parked;
        const waiting = mount.armTreeWait();
        const del = mount.deletePath(fileId);
        await waiting;
        gate.release();
        await Promise.all([move, del]);

        expect(await mount.getPath(fileId)).toBeNull();
        expect(await storage.exists('before/notes.txt')).toBe(false);
        expect(await storage.exists('after/notes.txt')).toBe(false);
        expect(storage.order).toEqual(['rename', 'delete']);
    });

    test('a move queued behind an in-flight write lands after the commit', async () => {
        const { mount, storage, folderId, fileId, oldKey } = await fileInFolder('move-after-put');
        const tempId = randomUUID();
        const { size, hash } = await writeTempWithHash(mount.getTempPath(tempId), Buffer.from('v1'));
        try {
            const gate = storage.armWrite();
            const write = mount.writeFileFromTemp(fileId, tempId, size, hash);
            await gate.parked;
            let moved = false;
            const waiting = mount.armTreeWait();
            const move = mount.updatePath(folderId, { name: 'after' }).then(() => {
                moved = true;
            });
            await waiting;
            gate.release();
            await write;
            expect((await mount.getPath(fileId))!.hash).toBe(hash);
            expect(moved).toBe(false);
            await move;

            const newKey = await mount.getStorageKey(fileId);
            expect(newKey).not.toBe(oldKey);
            expect(await storage.read(newKey).text()).toBe('v1');
            expect(await storage.exists(oldKey)).toBe(false);
            expect(storage.order).toEqual(['write', 'rename']);
        } finally {
            await mount.cleanupTemp(tempId);
        }
    });
});

// A restore's, a move's and a delete's pre-lock checks go stale while they queue; each re-answers under the lock.
describe('a restore, move or delete whose pre-lock check goes stale', () => {
    test('a restore racing a same-name create answers 409 and clobbers nothing', async () => {
        const { mount, storage, folderId, fileId } = await fileInFolder('restore-vs-create');
        await mount.trashPath(fileId);
        const trashedKey = await mount.getStorageKey(fileId);
        const gate = storage.armWrite();
        const create = mount.createFile(folderId, 'notes.txt', 'text/plain', 3, Buffer.from('NEW'));
        await gate.parked;
        const waiting = mount.armTreeWait();
        const restore = mount.restorePath(fileId);
        await waiting;
        gate.release();
        const createdId = await create;

        await expect(restore).rejects.toMatchObject({ status: 409 });
        expect(await storage.read(await mount.getStorageKey(createdId)).text()).toBe('NEW');
        expect(await mount.getStorageKey(fileId)).toBe(trashedKey);
        expect(await storage.exists(trashedKey)).toBe(true);
    });

    test('two moves that would form a cycle: the second answers 400 and the tree stays acyclic', async () => {
        const { mount, folderId: a } = await fileInFolder('move-cycle');
        const rootId = (await mount.getRootFolder())!.id;
        const b = await mount.createFolder(rootId, 'other');
        const moves = Promise.allSettled([mount.updatePath(a, { parentId: b }), mount.updatePath(b, { parentId: a })]);
        expect(await settlesWithin([moves], 5000)).toBe(true);

        const outcomes = await moves;
        const rejected = outcomes.filter((o) => o.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toMatchObject({ reason: { status: 400 } });
        const [keyA, keyB] = [await mount.getStorageKey(a), await mount.getStorageKey(b)];
        expect(keyA.startsWith(`${keyB}/`) || keyB.startsWith(`${keyA}/`)).toBe(true);
        expect(await settlesWithin([mount.invalidateSizesFrom(a)], 5000)).toBe(true);
        await expect(mount.updatePath(a, { parentId: a })).rejects.toMatchObject({ status: 400 });
    });

    // The second delete passes its row check, then queues behind the first and an exclusive holder,
    // so it reaches the lock only once the row is gone.
    test.each(['file', 'folder'] as const)('two deletes of one %s both resolve', async (type) => {
        const { mount, storage, folderId, fileId } = await fileInFolder(`delete-twice-${type}`);
        const pathId = type === 'file' ? fileId : folderId;
        const key = await mount.getStorageKey(pathId);
        const hold = Promise.withResolvers<void>();
        const held = mount.withTreeExclusive(() => hold.promise);
        const firstQueued = mount.armTreeWait();
        const first = mount.deletePath(pathId);
        await firstQueued;
        const between = mount.withTreeExclusive(async () => {});
        const secondQueued = mount.armTreeWait();
        const second = mount.deletePath(pathId);
        await secondQueued;
        hold.resolve();
        await Promise.all([held, first, between, second]);

        expect(await mount.getPath(pathId)).toBeNull();
        expect(existsSync(storage.getPath(key))).toBe(false);
    });
});
