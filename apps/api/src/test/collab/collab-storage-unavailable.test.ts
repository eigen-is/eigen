import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
    COLLAB_STORAGE_GONE_CLOSE,
    COLLAB_STORAGE_GONE_REASON,
    COLLAB_STORAGE_UNAVAILABLE_CLOSE,
    COLLAB_STORAGE_UNAVAILABLE_REASON,
} from '@workspace/lib/constants/collab';
import type { Snapshot } from '@workspace/lib/types/versioning';
import * as decoding from 'lib0/decoding';
import { MESSAGE_SYNC } from '../../lib/collab/collabDocument';
import type Drive from '../../lib/drive/drive';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount/mount';
import type { User } from '../../lib/user';
import type { FakeS3Server } from '../fake-s3-server';
import { createFakeS3Mount, type FakeS3Mount, removeFakeS3Mount, settleContainer } from '../fault-storage-helpers';
import { authedRequest, getTestContext } from '../setup';

// Unreachable storage closes the collab WS with 1013 'storage-unavailable', a stored object that is gone
// with 4410 'storage-gone', every other failed open with 1008. The mount's real S3Storage talks to a
// FakeS3Server. Needs a real listening server: app.handle() never completes the upgrade.

const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-collab-unavailable-${Date.now()}`);
const MOUNT_ID = 'fault-collab';

type CollabClient = { frames: number[]; closed: Promise<{ code: number; reason: string }> };

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let drive: Drive;
let mount: Mount;
let user: User;
let fakeS3: FakeS3Server;
let s3: FakeS3Mount;
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

function versionsUrl(docId: string, ...parts: string[]): string {
    return [`/drive/${ownerId}/${MOUNT_ID}/file/${docId}/versions`, ...parts].join('/');
}

async function saveVersion(docId: string): Promise<Snapshot> {
    const res = await authedRequest(token, versionsUrl(docId, 'save'), { method: 'POST' });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Snapshot;
    // The version's upload is queued; the restore reads the stored object.
    await mount.drainPendingUploads({ flushNow: true });
    return saved;
}

function restoreVersion(docId: string, name: string): Promise<Response> {
    return authedRequest(token, versionsUrl(docId, encodeURIComponent(name), 'restore'), { method: 'POST' });
}

async function storedBytes(key: string): Promise<string> {
    return Bun.hash(await fakeS3.store.read(key).arrayBuffer()).toString();
}

beforeAll(async () => {
    ctx = await getTestContext();
    ownerId = ctx.alice.user.id;
    token = ctx.alice.user.sessionToken;
    mkdirSync(TEST_DIR, { recursive: true });

    const home = await getHome(ownerId);
    s3 = await createFakeS3Mount(home, TEST_DIR, MOUNT_ID);
    ({ drive, mount, fake: fakeS3 } = s3);
    user = home.user;
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
    await removeFakeS3Mount(s3, openedDocIds);
    rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Collab WS open under unreachable storage', () => {
    test('a document whose storage object is gone closes 4410 storage-gone', async () => {
        expect(await openCollabClient(docId).closed).toEqual({
            code: COLLAB_STORAGE_GONE_CLOSE,
            reason: COLLAB_STORAGE_GONE_REASON,
        });
    });

    test('a failed local temp write on an intact object closes storage-unavailable, not storage-gone', async () => {
        const { docId } = await createDoc('TmpGone');
        const parked = `${mount.tmpDir}.parked`;
        renameSync(mount.tmpDir, parked);
        try {
            expect(await openCollabClient(docId).closed).toEqual({
                code: COLLAB_STORAGE_UNAVAILABLE_CLOSE,
                reason: COLLAB_STORAGE_UNAVAILABLE_REASON,
            });
        } finally {
            rmSync(mount.tmpDir, { recursive: true, force: true });
            renameSync(parked, mount.tmpDir);
        }
    }, 10_000);

    test('a gone object with a viable crash temp opens from the temp', async () => {
        const { docId, dataDbId, dataKey } = await createDoc('CrashTempWins');
        await seedStoredDoc(docId);
        await mount.downloadKeyToTemp(dataKey, dataDbId);
        await fakeS3.store.delete(dataKey);

        const reopened = await drive.getCollabDocument(MOUNT_ID, docId);
        expect(reopened.doc.getMap('probe').get('kept')).toBe('yes');
    }, 10_000);

    test('a gone object with a pending staged copy opens from the staged copy', async () => {
        const { docId, dataKey } = await createDoc('StagedWins');
        await seedStoredDoc(docId);
        // The next upload fails and its retry is held, so the staged copy stays pending.
        fakeS3.faults.set(dataKey, 'fail-put');
        const document = await drive.getCollabDocument(MOUNT_ID, docId);
        document.doc.getMap('probe').set('kept', 'staged');
        await drive.closeCollabDocument(MOUNT_ID, docId);
        expect(mount.pendingStagedCopy(dataKey)).not.toBeNull();
        await fakeS3.store.delete(dataKey);

        const reopened = await drive.getCollabDocument(MOUNT_ID, docId);
        expect(reopened.doc.getMap('probe').get('kept')).toBe('staged');
        fakeS3.faults.delete(dataKey);
    }, 10_000);

    test('a version restore on a gone document succeeds and the next open serves the version', async () => {
        const { docId, dataKey } = await createDoc('RestoreGone');
        await seedStoredDoc(docId);
        const saved = await saveVersion(docId);
        const document = await drive.getCollabDocument(MOUNT_ID, docId);
        document.doc.getMap('probe').set('kept', 'later');
        await drive.closeCollabDocument(MOUNT_ID, docId);
        await settleContainer(mount, docId);
        await fakeS3.store.delete(dataKey);

        expect((await restoreVersion(docId, saved.name)).status).toBe(200);
        const reopened = await drive.getCollabDocument(MOUNT_ID, docId);
        expect(reopened.doc.getMap('probe').get('kept')).toBe('yes');
    }, 10_000);

    test('a version restore while the bucket answers NoSuchBucket fails 503 and changes nothing', async () => {
        const { docId, dataDbId, dataKey } = await createDoc('RestoreNoBucket');
        await seedStoredDoc(docId);
        const saved = await saveVersion(docId);
        const versionsBefore = await (await authedRequest(token, versionsUrl(docId))).json();
        fakeS3.faults.set(dataKey, 'no-bucket');

        expect((await restoreVersion(docId, saved.name)).status).toBe(503);
        expect((await mount.getChildByName(docId, 'data.db'))?.id).toBe(dataDbId);
        expect(await (await authedRequest(token, versionsUrl(docId))).json()).toEqual(versionsBefore);
        fakeS3.faults.delete(dataKey);
        expect(await fakeS3.store.exists(dataKey)).toBe(true);
    }, 10_000);

    test('an ordinary failed open still closes 1008', async () => {
        expect((await openCollabClient('no-such-path').closed).code).toBe(1008);
    });
});

describe('Collab WS open whose download fails', () => {
    test('a 5xx on the GET closes with storage-unavailable', async () => {
        const { docId, dataKey } = await createDoc('Get500');
        fakeS3.faults.set(dataKey, 'fail-get');
        expect(await openCollabClient(docId).closed).toEqual({
            code: COLLAB_STORAGE_UNAVAILABLE_CLOSE,
            reason: COLLAB_STORAGE_UNAVAILABLE_REASON,
        });
    }, 10_000);

    // Only NoSuchKey in the GET body means the object is gone; a refused or missing bucket is an outage.
    test.each(['deny', 'no-bucket'] as const)(
        'a %s answer on the GET closes with storage-unavailable',
        async (fault) => {
            const { docId, dataKey } = await createDoc(`Get-${fault}`);
            fakeS3.faults.set(dataKey, fault);
            expect(await openCollabClient(docId).closed).toEqual({
                code: COLLAB_STORAGE_UNAVAILABLE_CLOSE,
                reason: COLLAB_STORAGE_UNAVAILABLE_REASON,
            });
        },
        10_000,
    );

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
