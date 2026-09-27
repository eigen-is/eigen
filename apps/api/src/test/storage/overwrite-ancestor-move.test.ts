import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BunFile } from 'bun';
import { Mount } from '../../lib/mount/mount';
import { LocalStorage } from '../../lib/storage/local-storage';
import { createGetLocalDatabase } from '../fault-storage-helpers';
import { createTestMountConfig } from '../mount-test-helpers';

// On `local` a file's key is its folder path: an ancestor renamed or trashed while an overwrite's
// write is on its way must not strand the new bytes at the old key.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-overwrite-ancestor-move-${Date.now()}`);
const OWNER_ID = 'test-owner-id';

// LocalStorage whose next write after arm parks until the test releases it.
class GatedLocalStorage extends LocalStorage {
    private gate: { parked: () => void; released: Promise<void> } | null = null;

    armWrite(): { parked: Promise<void>; release: () => void } {
        const parked = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        this.gate = { parked: parked.resolve, released: released.promise };
        return { parked: parked.promise, release: released.resolve };
    }

    override async write(key: string, data: Buffer | Uint8Array | ArrayBuffer | BunFile): Promise<number> {
        const gate = this.gate;
        if (gate) {
            this.gate = null;
            gate.parked();
            await gate.released;
        }
        return super.write(key, data);
    }
}

const createdMounts: Mount[] = [];

async function fileInFolder(id: string) {
    const mount = new Mount(OWNER_ID, TEST_DIR, createTestMountConfig(id, 'local'), createGetLocalDatabase(TEST_DIR));
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

// Open (AUDIT-S3-ROBUSTNESS-2026-09.md § Open, ancestor move): on a path-based mount the child's write
// and the parent's move run under different locks, so the bytes can land at the old key. A commit-side
// rename is not the fix (a move that lands after the PUT already carried the bytes; the rename then 404s).
describe('an overwrite racing an ancestor move on a path-based mount', () => {
    test.failing('a parent renamed during the write leaves the bytes at the new key only', async () => {
        const { mount, storage, folderId, fileId, oldKey } = await fileInFolder('ancestor-rename');
        const gate = storage.armWrite();
        const write = mount.writeFile(fileId, Buffer.from('v1'));
        await gate.parked;
        await mount.updatePath(folderId, { name: 'after' });
        gate.release();
        await write;

        const newKey = await mount.getStorageKey(fileId);
        expect(newKey).not.toBe(oldKey);
        expect(await storage.read(newKey).text()).toBe('v1');
        expect(await storage.exists(oldKey)).toBe(false);
    });

    test.failing('a parent trashed during the write leaves the bytes at the trashed key only', async () => {
        const { mount, storage, folderId, fileId, oldKey } = await fileInFolder('ancestor-trash');
        const gate = storage.armWrite();
        const write = mount.writeFile(fileId, Buffer.from('v1'));
        await gate.parked;
        await mount.trashPath(folderId);
        gate.release();
        await write;

        const newKey = await mount.getStorageKey(fileId);
        expect(newKey).not.toBe(oldKey);
        expect(await storage.read(newKey).text()).toBe('v1');
        expect(await storage.exists(oldKey)).toBe(false);
    });
});
