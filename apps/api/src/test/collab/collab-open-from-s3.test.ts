import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { COLLAB_EPOCH_MESSAGE, COLLAB_STORAGE_UNAVAILABLE_CLOSE } from '@workspace/lib/constants/collab';
import * as decoding from 'lib0/decoding';
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from '../../lib/collab/collabDocument';
import type Drive from '../../lib/drive/drive';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount/mount';
import type { StorageFile } from '../../lib/storage';
import { LocalStorage } from '../../lib/storage/local-storage';
import { S3Storage } from '../../lib/storage/s3-storage';
import type { User } from '../../lib/user';
import { FakeS3Server } from '../fake-s3-server';
import {
    createFaultMount,
    FaultStorage,
    registerFaultMount,
    settleContainer,
    unregisterFaultMount,
    waitFor,
} from '../fault-storage-helpers';
import { getTestContext } from '../setup';

// Collab opens whose data.db comes over Bun's real S3 client from a fake S3; needs a listening server (app.handle() never upgrades).

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-collab-open-from-s3-${Date.now()}`);
const MOUNT_ID = 'collab-open-s3';

// The mount's writes and exists() probes stay on the backing store; only its GETs cross the wire.
class S3ReadStorage extends FaultStorage {
    constructor(
        inner: LocalStorage,
        private readonly s3: S3Storage,
    ) {
        super(inner);
    }

    override read(key: string): StorageFile {
        return this.s3.read(key);
    }
}

type CollabClient = { ws: WebSocket; frames: number[]; closed: Promise<{ code: number; reason: string }> };

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let drive: Drive;
let mount: Mount;
let user: User;
let backing: LocalStorage;
let fakeS3: FakeS3Server;
let ownerId: string;
let token: string;
let port: number;
let rootId: string;
const openedDocIds: string[] = [];

// Records the message type of every binary frame: heartbeat and presence (awareness), epoch, sync.
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
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });
    return { ws, frames, closed };
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
    return Bun.hash(await backing.read(key).arrayBuffer()).toString();
}

beforeAll(async () => {
    ctx = await getTestContext();
    ownerId = ctx.alice.user.id;
    token = ctx.alice.user.sessionToken;
    mkdirSync(TEST_DIR, { recursive: true });

    backing = new LocalStorage(join(TEST_DIR, 'backing'));
    fakeS3 = new FakeS3Server(backing);
    const s3 = new S3Storage(await fakeS3.start());

    const home = await getHome(ownerId);
    drive = home.drive;
    user = home.user;
    ({ mount } = createFaultMount(ownerId, TEST_DIR, MOUNT_ID));
    mount.storage = new S3ReadStorage(backing, s3);
    await mount.init();
    registerFaultMount(drive, mount);
    rootId = (await mount.getRootFolder())!.id;

    const listenPort = ctx.app.listen(0).server?.port;
    expect(listenPort).toBeDefined();
    port = listenPort!;
});

afterAll(async () => {
    ctx.app.stop();
    fakeS3.heal();
    for (const docId of openedDocIds) await drive.closeCollabDocument(MOUNT_ID, docId).catch(() => {});
    unregisterFaultMount(drive, MOUNT_ID);
    await mount.closeAllDatabases();
    await fakeS3.stop();
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('a stalled download', () => {
    test('keeps the socket open on the loading heartbeat, then syncs once the GET completes', async () => {
        const { docId, dataKey } = await createDoc('Stalled');
        fakeS3.faults.set(dataKey, 'stall');
        const client = openCollabClient(docId);
        try {
            await waitFor(() => fakeS3.heldCount > 0);
            await waitFor(() => client.frames.length > 0);
            expect(client.frames).toEqual([MESSAGE_AWARENESS]);
            expect(client.ws.readyState).toBe(WebSocket.OPEN);

            fakeS3.heal();
            await waitFor(() => client.frames.includes(MESSAGE_SYNC));
            expect(client.frames.slice(0, 3)).toEqual([MESSAGE_AWARENESS, COLLAB_EPOCH_MESSAGE, MESSAGE_SYNC]);
        } finally {
            fakeS3.heal();
            client.ws.close();
            await client.closed;
        }
    }, 10_000);

    test('is shared: two opens during the stall wait on one GET and get the same document', async () => {
        const { docId, dataKey } = await createDoc('Shared');
        fakeS3.faults.set(dataKey, 'stall');
        const first = drive.getCollabDocument(MOUNT_ID, docId);
        try {
            await waitFor(() => fakeS3.heldCount > 0);
            const second = drive.getCollabDocument(MOUNT_ID, docId);
            fakeS3.heal();
            expect(await second).toBe(await first);
            expect(fakeS3.gets.get(dataKey)).toBe(1);
        } finally {
            fakeS3.heal();
        }
    }, 10_000);

    test('survives a reconnect: the new socket reuses the in-flight load and the closed one is dropped', async () => {
        const { docId, dataKey } = await createDoc('Reconnect');
        fakeS3.faults.set(dataKey, 'stall');
        const dropped = openCollabClient(docId);
        const reconnected = openCollabClient(docId);
        try {
            await waitFor(() => fakeS3.heldCount > 0);
            dropped.ws.close();
            await dropped.closed;
            await waitFor(() => reconnected.frames.length > 0);

            fakeS3.heal();
            await waitFor(() => reconnected.frames.includes(MESSAGE_SYNC));
            expect(dropped.frames).not.toContain(MESSAGE_SYNC);
            expect(fakeS3.gets.get(dataKey)).toBe(1);

            // The dropped socket is subscribed when the load lands, then unsubscribed by its gated close handler.
            const document = await drive.getCollabDocument(MOUNT_ID, docId);
            await waitFor(() => document.connectionCount === 1);
        } finally {
            fakeS3.heal();
            reconnected.ws.close();
            await reconnected.closed;
        }
    }, 10_000);
});

describe('a failed download', () => {
    // Gap CO-3: a GET that fails after exists() succeeded closes 1008, not storage-unavailable.
    test.failing('a 5xx on the GET closes with storage-unavailable, like an unreachable exists()', async () => {
        const { docId, dataKey } = await createDoc('Get500');
        fakeS3.faults.set(dataKey, 'fail');
        const client = openCollabClient(docId);
        expect(await client.closed).toEqual({
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

    // Gap CO-5: a failed load stays registered as an open document.
    test.failing('a load that failed leaves no open-document entry behind', async () => {
        const { docId, dataKey } = await createDoc('FailedEntry');
        fakeS3.faults.set(dataKey, 'fail');
        await drive.getCollabDocument(MOUNT_ID, docId).catch(() => {});
        fakeS3.faults.delete(dataKey);
        expect(drive.hasCollabDocument(MOUNT_ID, docId)).toBe(false);
    }, 10_000);
});
