import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { COLLAB_EPOCH_MESSAGE } from '@workspace/lib/constants/collab';
import * as decoding from 'lib0/decoding';
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from '../../lib/collab/collabDocument';
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
    waitFor,
} from '../fault-storage-helpers';
import { getTestContext } from '../setup';

// Collab opens whose data.db comes over Bun's real S3 client from a fake S3; needs a listening server (app.handle() never upgrades).

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-collab-open-from-s3-${Date.now()}`);
const MOUNT_ID = 'collab-open-s3';

type CollabClient = { ws: WebSocket; frames: number[]; closed: Promise<{ code: number; reason: string }> };

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let drive: Drive;
let mount: Mount;
let user: User;
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

async function createDoc(name: string): Promise<{ docId: string; dataKey: string }> {
    const doc = await drive.create(MOUNT_ID, rootId, name, 'doc', user);
    openedDocIds.push(doc.id);
    await settleContainer(mount, doc.id);
    const dataDb = (await mount.getChildByName(doc.id, 'data.db'))!;
    return { docId: doc.id, dataKey: await mount.getStorageKey(dataDb.id) };
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
        fakeS3.faults.set(dataKey, 'stall-body');
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
        const getsBefore = fakeS3.gets.get(dataKey) ?? 0;
        fakeS3.faults.set(dataKey, 'stall-body');
        const first = drive.getCollabDocument(MOUNT_ID, docId);
        try {
            await waitFor(() => fakeS3.heldCount > 0);
            const second = drive.getCollabDocument(MOUNT_ID, docId);
            fakeS3.heal();
            expect(await second).toBe(await first);
            expect(fakeS3.gets.get(dataKey)).toBe(getsBefore + 1);
        } finally {
            fakeS3.heal();
        }
    }, 10_000);
});
