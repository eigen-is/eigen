import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SSEventType } from '@workspace/lib/types/sse';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import { ApiError } from '../../lib/core';
import type Drive from '../../lib/drive/drive';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount/mount';
import type { User } from '../../lib/user';
import {
    createFaultMount,
    type FaultStorage,
    registerFaultMount,
    settleContainer,
    unregisterFaultMount,
} from '../fault-storage-helpers';
import { collectSSE, getTestContext } from '../setup';

// Create must be atomic: when provisioning a container's managed dbs (or a card chat's comment-index
// row) fails on degraded storage, the container row must not survive. A surviving row is announced
// over SSE, occupies the name, and 503s on every later open — the phantom-row shape the rollback in
// Drive.create closes. The mount here is a real Drive mount whose storage is a FaultStorage.

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
    fault.failReadKeys.clear();
});

afterAll(async () => {
    unregisterFaultMount(drive, MOUNT_ID);
    await mount.closeAllDatabases();
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Drive.create is atomic under degraded storage', () => {
    test('a failed document provisioning leaves no row, emits nothing, and a same-name retry succeeds', async () => {
        const sse = collectSSE(ownerId);
        await new Promise((resolve) => setTimeout(resolve, 50)); // collectSSE subscribes asynchronously

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
        const sse = collectSSE(ownerId);
        await new Promise((resolve) => setTimeout(resolve, 50));

        await expect(drive.create(MOUNT_ID, chatFolder.id, 'Card 1', 'chat', user)).rejects.toThrow();

        expect(await mount.getChildByName(chatFolder.id, 'Card 1.eigenchat')).toBeNull();
        sse.stop();
        expect(sse.events.some((e) => e.type === SSEventType.DRIVE_FILE_CREATED)).toBe(false);

        fault.failReadKeys.clear();
        const card = await drive.create(MOUNT_ID, chatFolder.id, 'Card 1', 'chat', user);
        expect(card.name).toBe('Card 1.eigenchat');
    });

    test('a data.db row whose storage object is gone still 503s on open (mustExist stays strict)', async () => {
        const doc = await drive.create(MOUNT_ID, rootId, 'Vanishing', 'doc', user);
        const dataDb = (await mount.getChildByName(doc.id, 'data.db'))!;
        await settleContainer(mount, doc.id);
        const key = await mount.getStorageKey(dataDb.id);

        await fault.inner.delete(key);
        const missing = await mount.openDatabase(COLLAB_DB_CONFIG, dataDb.id).catch((e: unknown) => e);
        expect(missing).toBeInstanceOf(ApiError);
        expect(missing).toMatchObject({ status: 503 });

        // A 0-byte object is the same refusal one layer down: ManagedDatabase's mustExist guard
        // must not open an empty working copy as a fresh database.
        await fault.inner.write(key, new Uint8Array(0));
        const empty = await mount.openDatabase(COLLAB_DB_CONFIG, dataDb.id).catch((e: unknown) => e);
        expect(empty).toBeInstanceOf(ApiError);
        expect(empty).toMatchObject({ status: 503 });
    });
});
