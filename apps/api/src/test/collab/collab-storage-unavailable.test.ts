import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { COLLAB_STORAGE_UNAVAILABLE_CLOSE } from '@workspace/lib/constants/collab';
import * as decoding from 'lib0/decoding';
import { MESSAGE_SYNC } from '../../lib/collab/collabDocument';
import type Drive from '../../lib/drive/drive';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount/mount';
import { LocalStorage } from '../../lib/storage/local-storage';
import type { User } from '../../lib/user';
import { FakeS3Server } from '../fake-s3-server';
import {
    createGetLocalDatabase,
    createS3MountConfig,
    FaultMount,
    registerFaultMount,
    settleContainer,
    unregisterFaultMount,
} from '../fault-storage-helpers';
import { getTestContext } from '../setup';

// Unreachable storage closes the collab WS with 1013 'storage-unavailable', every other failed open
// with 1008. The mount's real S3Storage talks to a FakeS3Server. Needs a real listening server:
// app.handle() never completes the upgrade.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-collab-unavailable-${Date.now()}`);
const MOUNT_ID = 'fault-collab';

type CollabClient = { frames: number[]; closed: Promise<{ code: number; reason: string }> };

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let drive: Drive;
let mount: Mount;
let user: User;
let fakeS3: FakeS3Server;
let ownerId: string;
let token: string;
let port: number;
let rootId: string;
let docId: string;
const openedDocIds: string[] = [];

// Records the message type of every binary frame. Resolves on close, whatever happens first: the
// route closes right after the upgrade, so onopen may or may not have fired by then.
function openCollabClient(pathId: string): CollabClient {
    const ws = new WebSocket(`ws://localhost:${port}/ws/collab/${ownerId}/${MOUNT_ID}/${pathId}`, {
        headers: { cookie: `better-auth.session_token=${token}` },
    } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    const frames: number[] = [];
    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            frames.push(decoding.readVarUint(decoding.createDecoder(new Uint8Array(event.data))));
        }
    };
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
        ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
        ws.onerror = (e) => reject(e);
    });
    return { frames, closed };
}

async function createDoc(name: string): Promise<{ docId: string; dataDbId: string; dataKey: string }> {
    const doc = await drive.create(MOUNT_ID, rootId, name, 'doc', user);
    openedDocIds.push(doc.id);
    await settleContainer(mount, doc.id);
    const dataDb = (await mount.getChildByName(doc.id, 'data.db'))!;
    return { docId: doc.id, dataDbId: dataDb.id, dataKey: await mount.getStorageKey(dataDb.id) };
}

// Put real content into the stored data.db, then close everything so the next open downloads it.
async function seedStoredDoc(docId: string): Promise<void> {
    const document = await drive.getCollabDocument(MOUNT_ID, docId);
    document.doc.getMap('probe').set('kept', 'yes');
    await drive.closeCollabDocument(MOUNT_ID, docId);
    await settleContainer(mount, docId);
}

async function storedBytes(key: string): Promise<string> {
    return Bun.hash(await fakeS3.store.read(key).arrayBuffer()).toString();
}

beforeAll(async () => {
    ctx = await getTestContext();
    ownerId = ctx.alice.user.id;
    token = ctx.alice.user.sessionToken;
    mkdirSync(TEST_DIR, { recursive: true });

    fakeS3 = new FakeS3Server(new LocalStorage(join(TEST_DIR, 'backing')));
    const s3Config = await fakeS3.start();
    const home = await getHome(ownerId);
    drive = home.drive;
    user = home.user;
    mount = new FaultMount(
        ownerId,
        TEST_DIR,
        { ...createS3MountConfig(MOUNT_ID), s3Config },
        createGetLocalDatabase(TEST_DIR),
    );
    await mount.init();
    registerFaultMount(drive, mount);
    rootId = (await mount.getRootFolder())!.id;

    const doc = await createDoc('Unreachable');
    docId = doc.docId;
    await mount.storage.delete(doc.dataKey);

    const listenPort = ctx.app.listen(0).server?.port;
    expect(listenPort).toBeDefined();
    port = listenPort!;
});

afterAll(async () => {
    ctx.app.stop();
    fakeS3.heal();
    for (const id of openedDocIds) await drive.closeCollabDocument(MOUNT_ID, id).catch(() => {});
    unregisterFaultMount(drive, MOUNT_ID);
    await mount.closeAllDatabases();
    await fakeS3.stop();
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Collab WS open under unreachable storage', () => {
    test('a document whose storage object is gone closes 1013 storage-unavailable', async () => {
        expect(await openCollabClient(docId).closed).toEqual({
            code: COLLAB_STORAGE_UNAVAILABLE_CLOSE,
            reason: 'storage-unavailable',
        });
    });

    test('an ordinary failed open still closes 1008', async () => {
        expect((await openCollabClient('no-such-path').closed).code).toBe(1008);
    });
});

describe('Collab WS open whose download fails', () => {
    test('a 5xx on the GET closes with storage-unavailable, like an unreachable exists()', async () => {
        const { docId, dataKey } = await createDoc('Get500');
        fakeS3.faults.set(dataKey, 'fail-get');
        expect(await openCollabClient(docId).closed).toEqual({
            code: COLLAB_STORAGE_UNAVAILABLE_CLOSE,
            reason: 'storage-unavailable',
        });
    }, 10_000);

    test('a body cut short fails the open, leaves no temp and never touches the stored object', async () => {
        const { docId, dataDbId, dataKey } = await createDoc('Cut');
        await seedStoredDoc(docId);
        const before = await storedBytes(dataKey);

        fakeS3.faults.set(dataKey, 'cut');
        const client = openCollabClient(docId);
        const { code } = await client.closed;
        expect(code).not.toBe(1000);
        expect(client.frames).not.toContain(MESSAGE_SYNC);
        expect(existsSync(mount.getTempPath(dataDbId))).toBe(false);
        expect(await storedBytes(dataKey)).toBe(before);

        fakeS3.faults.delete(dataKey);
        const reopened = await drive.getCollabDocument(MOUNT_ID, docId);
        expect(reopened.doc.getMap('probe').get('kept')).toBe('yes');
    }, 10_000);

    test('an empty 200 is refused as storage-unavailable, never opened as a fresh document', async () => {
        const { docId, dataKey } = await createDoc('Empty');
        await seedStoredDoc(docId);
        const before = await storedBytes(dataKey);

        fakeS3.faults.set(dataKey, 'empty');
        const client = openCollabClient(docId);
        expect((await client.closed).code).toBe(COLLAB_STORAGE_UNAVAILABLE_CLOSE);
        expect(client.frames).not.toContain(MESSAGE_SYNC);
        await mount.drainPendingUploads({ flushNow: true });
        expect(await storedBytes(dataKey)).toBe(before);

        fakeS3.faults.delete(dataKey);
        const reopened = await drive.getCollabDocument(MOUNT_ID, docId);
        expect(reopened.doc.getMap('probe').get('kept')).toBe('yes');
    }, 10_000);

    test('a load that failed leaves no open-document entry behind', async () => {
        const { docId, dataKey } = await createDoc('FailedEntry');
        fakeS3.faults.set(dataKey, 'fail-get');
        await drive.getCollabDocument(MOUNT_ID, docId).catch(() => {});
        fakeS3.faults.delete(dataKey);
        expect(drive.hasCollabDocument(MOUNT_ID, docId)).toBe(false);
    }, 10_000);
});
