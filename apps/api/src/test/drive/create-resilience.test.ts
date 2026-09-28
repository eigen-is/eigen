import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SSEventType } from '@workspace/lib/types/sse';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import { ApiError } from '../../lib/core';
import type Drive from '../../lib/drive/drive';
import { getHome } from '../../lib/home';
import { createMountConfig } from '../../lib/mount';
import type { Mount } from '../../lib/mount/mount';
import type { User } from '../../lib/user';
import { VERSIONS_FOLDER_NAME } from '../../lib/versioning/versions-folder';
import {
    createFaultMount,
    type FaultStorage,
    registerFaultMount,
    settleContainer,
    unregisterFaultMount,
    waitFor,
} from '../fault-storage-helpers';
import { collectSSE, findOrFail, getTestContext } from '../setup';

// Drive.create over a FaultStorage mount: a provisioning failure must leave no container row, since a
// surviving row occupies the name and 503s on every later open. A failed upload leaves no temp behind.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-create-resilience-${Date.now()}`);
const MOUNT_ID = 'fault-create';

let drive: Drive;
let mount: Mount;
let fault: FaultStorage;
let user: User;
let ownerId: string;
let rootId: string;

beforeAll(async () => {
    const ctx = await getTestContext();
    ownerId = ctx.alice.user.id;
    mkdirSync(TEST_DIR, { recursive: true });
    const home = await getHome(ownerId);
    drive = home.drive;
    user = home.user;
    ({ mount, fault } = createFaultMount(ownerId, TEST_DIR, MOUNT_ID));
    await mount.init();
    registerFaultMount(drive, mount);
    rootId = (await mount.getRootFolder())!.id;
});

// Injections are per-test: a leaked one would fail the NEXT test's teardown, not its assertions.
afterEach(() => {
    fault.failNextExists = 0;
    fault.failNextWrites = 0;
    fault.failReadKeys.clear();
});

afterAll(async () => {
    unregisterFaultMount(drive, MOUNT_ID);
    await mount.closeAllDatabases();
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Drive.create is atomic under degraded storage', () => {
    test('a failed document provisioning leaves no row, emits nothing, and a same-name retry succeeds', async () => {
        const sse = await collectSSE(ownerId);

        fault.failNextExists = 1; // the create-mode probe for the container's data.db
        await expect(drive.create(MOUNT_ID, rootId, 'Notes', 'doc', user)).rejects.toThrow();

        const listing = await drive.getFolderContents(MOUNT_ID, rootId);
        expect(listing.find((p) => p.name === 'Notes.eigendoc')).toBeUndefined();
        sse.stop();
        expect(sse.events.some((e) => e.type === SSEventType.DRIVE_FILE_CREATED)).toBe(false);

        const created = await drive.create(MOUNT_ID, rootId, 'Notes', 'doc', user);
        expect(created.name).toBe('Notes.eigendoc');
    });

    test('a card chat whose comment index is unreachable leaves no chat row and retries cleanly', async () => {
        const board = await drive.create(MOUNT_ID, rootId, 'Board', 'stickies', user);
        const chatFolder = (await mount.getChildByName(board.id, 'chat'))!;
        const commentsDb = (await mount.getChildByName(board.id, 'comments.db'))!;
        await settleContainer(mount, board.id);

        // The chat's own data.db provisions fine; only the GET of the board's comment index fails,
        // so the failure lands in seedCommentRow — after ChatRoom.create already succeeded.
        fault.failReadKeys.add(await mount.getStorageKey(commentsDb.id));
        const sse = await collectSSE(ownerId);

        await expect(drive.create(MOUNT_ID, chatFolder.id, 'Card 1', 'chat', user)).rejects.toThrow();

        expect(await mount.getChildByName(chatFolder.id, 'Card 1.eigenchat')).toBeNull();
        sse.stop();
        expect(sse.events.some((e) => e.type === SSEventType.DRIVE_FILE_CREATED)).toBe(false);

        fault.failReadKeys.clear();
        const card = await drive.create(MOUNT_ID, chatFolder.id, 'Card 1', 'chat', user);
        expect(card.name).toBe('Card 1.eigenchat');
    });

    test('a data.db row whose storage object is gone 410s on open, and an empty one 503s (mustExist stays strict)', async () => {
        const doc = await drive.create(MOUNT_ID, rootId, 'Vanishing', 'doc', user);
        const dataDb = (await mount.getChildByName(doc.id, 'data.db'))!;
        await settleContainer(mount, doc.id);
        const key = await mount.getStorageKey(dataDb.id);

        await fault.inner.delete(key);
        const missing = await mount.openDatabase(COLLAB_DB_CONFIG, dataDb.id).catch((e: unknown) => e);
        expect(missing).toBeInstanceOf(ApiError);
        expect(missing).toMatchObject({ status: 410 });

        // A 0-byte object is the same refusal one layer down: ManagedDatabase's mustExist guard
        // must not open an empty working copy as a fresh database.
        await fault.inner.write(key, new Uint8Array(0));
        const empty = await mount.openDatabase(COLLAB_DB_CONFIG, dataDb.id).catch((e: unknown) => e);
        expect(empty).toBeInstanceOf(ApiError);
        expect(empty).toMatchObject({ status: 503 });
    });

    test('a data.db file deleted from a local mount 410s on open', async () => {
        const home = await getHome(ownerId);
        const settings = await home.settings.set({
            mounts: { 'local-gone': { storageType: 'local', maxSizeMB: 100, enabled: true, name: 'Local' } },
        });
        await drive.addMount(createMountConfig('local-gone', settings.mounts!['local-gone']));
        const localMount = findOrFail(drive.getMounts(), (m) => m.id === 'local-gone');
        const localRoot = (await localMount.getRootFolder())!;
        const doc = await drive.create('local-gone', localRoot.id, 'Vanishing', 'doc', user);
        const dataDb = (await localMount.getChildByName(doc.id, 'data.db'))!;
        await settleContainer(localMount, doc.id);

        rmSync(localMount.storage.getPath!(await localMount.getStorageKey(dataDb.id)));
        const missing = await localMount.openDatabase(COLLAB_DB_CONFIG, dataDb.id).catch((e: unknown) => e);
        expect(missing).toBeInstanceOf(ApiError);
        expect(missing).toMatchObject({ status: 410 });
    });
});

describe('Version restore under degraded storage', () => {
    test('a version saved while its upload fails restores from its staged copy', async () => {
        const doc = await drive.create(MOUNT_ID, rootId, 'Outage Version', 'sheets', user);
        const seeded = await drive.getCollabDocument(MOUNT_ID, doc.id);
        seeded.doc.getMap('state').set('marker', 'saved');
        await drive.closeCollabDocument(MOUNT_ID, doc.id);
        await settleContainer(mount, doc.id);

        // The version's PUT is the only write; retries are held (FaultMount), so it stays a staged copy.
        fault.failNextWrites = 1;
        const saved = await drive.saveVersion(MOUNT_ID, doc.id);
        await waitFor(() => fault.failNextWrites === 0);
        const versions = (await mount.getChildByName(doc.id, VERSIONS_FOLDER_NAME))!;
        const versionKey = await mount.getStorageKey((await mount.getChildByName(versions.id, saved.name))!.id);
        expect(await fault.inner.exists(versionKey)).toBe(false);

        const document = await drive.getCollabDocument(MOUNT_ID, doc.id);
        document.doc.getMap('state').set('marker', 'later');
        await drive.restoreContainer(MOUNT_ID, doc.id, saved.name);
        expect(document.doc.getMap('state').get('marker')).toBe('saved');
        await drive.closeCollabDocument(MOUNT_ID, doc.id);
        await settleContainer(mount, doc.id);
    });
});

describe('Drive.uploadFiles under degraded storage', () => {
    test('a failed PUT removes the temp of every file streamed after it', async () => {
        const form = new FormData();
        form.append('file', new File(['a'], 'first.txt'));
        form.append('file', new File(['b'], 'second.txt'));
        const request = new Request('http://localhost/upload', { method: 'POST', body: form });
        const before = new Set(readdirSync(mount.tmpDir));

        fault.failNextWrites = 1;
        await expect(drive.uploadFiles(MOUNT_ID, rootId, request, 1024, user)).rejects.toThrow();
        expect(readdirSync(mount.tmpDir).filter((entry) => !before.has(entry))).toEqual([]);
    });
});
