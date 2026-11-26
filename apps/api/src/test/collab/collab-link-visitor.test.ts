import type { Mock } from 'bun:test';
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { COLLAB_ACCESS_LOST_CLOSE, COLLAB_ACCESS_LOST_REASON } from '@workspace/lib/constants/collab';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { updateServerSettings } from '../../lib/config/server-settings';
import { getSharedDatabase } from '../../lib/drive/shared';
import { recentPaths } from '../../lib/drive/shared-schema';
import { getHome } from '../../lib/home/get-home';
import { waitFor } from '../fault-storage-helpers';
import type { TestUser } from '../setup';
import {
    app,
    assertJson,
    authedRequest,
    driveDelete,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    eventually,
    firstMountId,
    getTestContext,
} from '../setup';

// A collab document behind a public link, opened without a login: the socket and the info route. Needs a real
// listening server. A visitor is a socket with no cookie. Each client here speaks y-websocket's handshake with
// y-protocols' own reader, as the browser does. The tests run a keepalive tick by hand: the callback each socket
// gave setInterval, the real one, with no wait.

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const STEP_1 = syncProtocol.messageYjsSyncStep1;
const STEP_2 = syncProtocol.messageYjsSyncStep2;

const ACCESS_LOST = { code: COLLAB_ACCESS_LOST_CLOSE, reason: COLLAB_ACCESS_LOST_REASON };
const NO_INFO = { canRead: false, canWrite: false, path: null, folderContents: null };

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let alice: TestUser;
let bob: TestUser;
let aliceId: string;
let mountId: string;
let root: DrivePath;
let port: number | undefined;
const sockets = new Set<WebSocket>();
let intervals: Mock<typeof setInterval>;

function withPublicLinks(on: boolean): Promise<void> {
    return updateServerSettings({ sharing: { publicLinks: on } });
}

beforeAll(async () => {
    intervals = spyOn(globalThis, 'setInterval');
    ctx = await getTestContext();
    alice = ctx.alice.user;
    bob = ctx.bob.user;
    aliceId = alice.id;
    mountId = await firstMountId(alice.sessionToken, aliceId);
    root = await driveGet(alice.sessionToken, aliceId, mountId, 'root');
    port = ctx.app.listen(0).server?.port;
});

afterEach(() => {
    for (const ws of sockets) ws.close();
    sockets.clear();
    intervals.mockClear();
});

afterAll(() => {
    ctx.app.stop();
    intervals.mockRestore();
});

// Runs every keepalive once and waits for its checks.
async function tick(): Promise<void> {
    await Promise.all(intervals.mock.calls.filter(([, ms]) => ms === 15_000).map(([keepalive]) => keepalive()));
}

async function setVisibility(pathId: string, visibility: 'link' | 'private'): Promise<void> {
    const res = await authedRequest(alice.sessionToken, `/drive/${aliceId}/${mountId}/path/${pathId}/acl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility }),
    });
    expect(res.status).toBe(200);
}

function newFolder(parentId = root.id): Promise<DrivePath> {
    return drivePost(alice.sessionToken, aliceId, mountId, `folder/${parentId}`, {
        folderName: `Visitor folder ${crypto.randomUUID()}`,
    });
}

function newDoc(parentId = root.id): Promise<DrivePath> {
    return drivePost(alice.sessionToken, aliceId, mountId, `folder/${parentId}/create/doc`, {
        fileName: `Visitor probe ${crypto.randomUUID()}`,
    });
}

async function newPublicDoc(): Promise<DrivePath> {
    const doc = await newDoc();
    await setVisibility(doc.id, 'link');
    return doc;
}

// A copy on a plain ArrayBuffer, which is what WebSocket.send takes.
function frameOf(encoder: encoding.Encoder): Uint8Array<ArrayBuffer> {
    return new Uint8Array(encoding.toUint8Array(encoder));
}

function syncFrame(write: (encoder: encoding.Encoder) => void): Uint8Array<ArrayBuffer> {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    write(encoder);
    return frameOf(encoder);
}

type AwarenessEntry = { clientId: number; state: unknown };

// The layout y-protocols' encodeAwarenessUpdate produces: a count, then per entry a client id, a clock and a state.
function awarenessFrame(clientId: number, clock: number, state: unknown): Uint8Array<ArrayBuffer> {
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 1);
    encoding.writeVarUint(update, clientId);
    encoding.writeVarUint(update, clock);
    encoding.writeVarString(update, JSON.stringify(state));
    const frame = encoding.createEncoder();
    encoding.writeVarUint(frame, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(frame, encoding.toUint8Array(update));
    return frameOf(frame);
}

// A y-websocket client: it sends its step 1 when the socket opens, answers the server's step 1 with a step 2, applies
// what the server sends and sends its own edits as updates. No user means no cookie.
function connect(user: TestUser | null, pathId: string) {
    // Bun's WebSocket takes headers, which the DOM type the compiler sees does not know.
    const ws: WebSocket = Reflect.construct(WebSocket, [
        `ws://localhost:${port}/ws/collab/${aliceId}/${mountId}/${pathId}`,
        { headers: user ? { cookie: `better-auth.session_token=${user.sessionToken}` } : {} },
    ]);
    ws.binaryType = 'arraybuffer';
    sockets.add(ws);
    const doc = new Y.Doc();
    // The kind of each sync frame the server sent, and every awareness state a peer published. The loading heartbeat
    // is an awareness frame with no state in it, and the server's own state, which a member gets at sync, is empty.
    const syncFrames: number[] = [];
    const awareness: AwarenessEntry[] = [];

    ws.onopen = () => ws.send(syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, doc)));
    doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(syncFrame((encoder) => syncProtocol.writeUpdate(encoder, update)));
    });
    ws.onmessage = ({ data }) => {
        if (!(data instanceof ArrayBuffer)) return;
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const messageType = decoding.readVarUint(decoder);
        if (messageType === MESSAGE_SYNC) {
            const reply = encoding.createEncoder();
            encoding.writeVarUint(reply, MESSAGE_SYNC);
            syncFrames.push(syncProtocol.readSyncMessage(decoder, reply, doc, ws));
            if (encoding.length(reply) > 1) ws.send(frameOf(reply));
        } else if (messageType === MESSAGE_AWARENESS) {
            const entries = decoding.createDecoder(decoding.readVarUint8Array(decoder));
            const count = decoding.readVarUint(entries);
            for (let i = 0; i < count; i++) {
                const clientId = decoding.readVarUint(entries);
                decoding.readVarUint(entries);
                const state = decoding.readVarString(entries);
                if (state !== '{}') awareness.push({ clientId, state: JSON.parse(state) });
            }
        }
    };
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.onclose = ({ code, reason }) => resolve({ code, reason });
    });
    const count = (kind: number) => syncFrames.filter((frame) => frame === kind).length;
    return { ws, doc, closed, awareness, count, text: () => doc.getText('probe').toString() };
}

type Client = ReturnType<typeof connect>;

// Resolves once the handshake is done both ways: the server's step 2 arrived, and its step 1, which the client
// answered with its own step 2.
async function open(user: TestUser | null, pathId: string): Promise<Client> {
    const client = connect(user, pathId);
    await waitFor(() => client.count(STEP_1) > 0 && client.count(STEP_2) > 0, 10_000);
    return client;
}

// The server handles one socket's frames in order and sends in order, so once this step 1 is answered the server has
// handled every frame the client sent before it, and the client has every frame the server sent it before the answer.
async function roundTrip(client: Client): Promise<void> {
    const before = client.count(STEP_2);
    client.ws.send(syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, client.doc)));
    await waitFor(() => client.count(STEP_2) > before, 5_000);
}

function write(client: Client, text: string): void {
    client.doc.getText('probe').insert(client.doc.getText('probe').length, text);
}

function presence(user: TestUser): unknown {
    return { user: { userId: user.id, name: user.name, color: '#123456' } };
}

async function storedText(pathId: string): Promise<string> {
    const document = await (await getHome(aliceId)).drive.getCollabDocument(mountId, pathId);
    return document.doc.getText('probe').toString();
}

async function recentIds(user: TestUser): Promise<string[]> {
    const sharedDb = await getSharedDatabase(await getHome(user.id));
    return sharedDb
        .select()
        .from(recentPaths)
        .all()
        .map((row) => row.pathId);
}

describe('a socket without a login opens what a public link opens', () => {
    test('a public document: the handshake syncs its content, and a later edit reaches the visitor', async () => {
        const doc = await newPublicDoc();
        const member = await open(alice, doc.id);
        write(member, 'hello');
        await roundTrip(member);

        const visitor = await open(null, doc.id);
        expect(visitor.text()).toBe('hello');
        await roundTrip(visitor);
        expect(visitor.ws.readyState).toBe(WebSocket.OPEN);

        write(member, ' world');
        await waitFor(() => visitor.text() === 'hello world', 5_000);
        expect(visitor.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('a document inside a public folder', async () => {
        const folder = await newFolder();
        const doc = await newDoc(folder.id);
        await setVisibility(folder.id, 'link');
        const member = await open(alice, doc.id);
        write(member, 'inside');
        await roundTrip(member);

        const visitor = await open(null, doc.id);
        expect(visitor.text()).toBe('inside');
    });

    test('every step 1 is answered, as y-websocket sends one every few seconds, and the socket stays', async () => {
        const doc = await newPublicDoc();
        const visitor = await open(null, doc.id);
        const before = visitor.count(STEP_2);
        for (let i = 0; i < 3; i++) {
            visitor.ws.send(syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, visitor.doc)));
        }
        await waitFor(() => visitor.count(STEP_2) === before + 3, 5_000);
        expect(visitor.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('a private document, an unknown id and a chat close with access lost', async () => {
        const folder = await newFolder();
        await setVisibility(folder.id, 'link');
        const chat = await drivePost<DrivePath>(
            alice.sessionToken,
            aliceId,
            mountId,
            `folder/${folder.id}/create/chat`,
            { fileName: `visitor-room-${crypto.randomUUID()}` },
        );
        const privateDoc = await newDoc();

        for (const pathId of [privateDoc.id, crypto.randomUUID(), chat.id]) {
            const visitor = connect(null, pathId);
            expect(await visitor.closed).toEqual(ACCESS_LOST);
            expect(visitor.count(STEP_1) + visitor.count(STEP_2)).toBe(0);
        }
    });

    // The rule admits a folder and a file. Neither is a document, so the open fails as it does for a member.
    test('a public folder and a public file are no document: 1008', async () => {
        const folder = await newFolder();
        await setVisibility(folder.id, 'link');
        const file = await driveUpload(
            alice.sessionToken,
            aliceId,
            mountId,
            folder.id,
            new File(['plain'], 'plain.txt', { type: 'text/plain' }),
        );
        for (const pathId of [folder.id, file.id]) {
            expect((await connect(null, pathId).closed).code).toBe(1008);
            expect((await connect(alice, pathId).closed).code).toBe(1008);
        }
    });

    test('with public links off a public document closes with access lost', async () => {
        const doc = await newPublicDoc();
        await withPublicLinks(false);
        try {
            expect(await connect(null, doc.id).closed).toEqual(ACCESS_LOST);
        } finally {
            await withPublicLinks(true);
        }
    });
});

describe('a visitor has no awareness, either way', () => {
    test('it gets no state at sync and none after, while a signed-in reader gets both', async () => {
        const doc = await newPublicDoc();
        const member = await open(alice, doc.id);
        member.ws.send(awarenessFrame(101, 1, presence(alice)));
        await roundTrip(member);

        const visitor = await open(null, doc.id);
        const reader = await open(bob, doc.id);
        await waitFor(() => reader.awareness.length === 1, 5_000);

        member.ws.send(awarenessFrame(101, 2, presence(alice)));
        await roundTrip(member);
        await waitFor(() => reader.awareness.length === 2, 5_000);
        await roundTrip(visitor);

        expect(reader.awareness.map((entry) => entry.clientId)).toEqual([101, 101]);
        expect(visitor.awareness).toEqual([]);
    });

    test('its own awareness frame reaches nobody', async () => {
        const doc = await newPublicDoc();
        const member = await open(alice, doc.id);
        const visitor = await open(null, doc.id);

        visitor.ws.send(awarenessFrame(202, 1, { user: { name: 'Visitor', color: '#ff0000' } }));
        visitor.ws.send(awarenessFrame(203, 1, presence(alice)));
        await roundTrip(visitor);
        await roundTrip(member);
        expect(member.awareness).toEqual([]);

        // Nor does it stay for whoever connects next.
        const reader = await open(bob, doc.id);
        await roundTrip(reader);
        expect(reader.awareness).toEqual([]);
        expect(visitor.ws.readyState).toBe(WebSocket.OPEN);
    });

    // The reader gets the removal from the same send as the visitor would, so once it has it the visitor's is due.
    test("a member's disconnect sends the visitor nothing", async () => {
        const doc = await newPublicDoc();
        const member = await open(alice, doc.id);
        member.ws.send(awarenessFrame(401, 1, presence(alice)));
        await roundTrip(member);
        const visitor = await open(null, doc.id);
        const reader = await open(bob, doc.id);
        await waitFor(() => reader.awareness.length === 1, 5_000);

        member.ws.close();
        await waitFor(() => reader.awareness.some((entry) => entry.state === null), 5_000);
        await roundTrip(visitor);
        expect(visitor.awareness).toEqual([]);
    });
});

describe('a visitor may send almost nothing', () => {
    test('its step 2 and its update do not change the document', async () => {
        const doc = await newPublicDoc();
        const member = await open(alice, doc.id);
        write(member, 'kept');
        await roundTrip(member);

        // What the visitor wrote before it connected travels in its step 2, and what it writes after in an update.
        const visitor = connect(null, doc.id);
        write(visitor, 'offline');
        await waitFor(() => visitor.count(STEP_1) > 0 && visitor.count(STEP_2) > 0, 10_000);
        write(visitor, 'online');
        await roundTrip(visitor);
        expect(visitor.ws.readyState).toBe(WebSocket.OPEN);

        await roundTrip(member);
        expect(member.text()).toBe('kept');
        expect(await storedText(doc.id)).toBe('kept');

        // What is stored, read back from data.db by a fresh open.
        await (await getHome(aliceId)).drive.closeCollabDocument(mountId, doc.id);
        expect(await storedText(doc.id)).toBe('kept');
    });

    test('a frame over 64 KiB closes it with 1008, and a member sends the same frame', async () => {
        const doc = await newPublicDoc();
        const big = new Y.Doc();
        big.getText('probe').insert(0, 'x'.repeat(64 * 1024));
        const frame = syncFrame((encoder) => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(big)));
        expect(frame.byteLength).toBeGreaterThan(64 * 1024);

        const visitor = await open(null, doc.id);
        visitor.ws.send(frame);
        expect((await visitor.closed).code).toBe(1008);

        const member = await open(alice, doc.id);
        member.ws.send(frame);
        await roundTrip(member);
        expect(member.ws.readyState).toBe(WebSocket.OPEN);
        expect((await storedText(doc.id)).length).toBe(64 * 1024);
    });

    test('a frame under the cap leaves it open', async () => {
        const doc = await newPublicDoc();
        const small = new Y.Doc();
        small.getText('probe').insert(0, 'x'.repeat(60 * 1024));
        const visitor = await open(null, doc.id);
        visitor.ws.send(syncFrame((encoder) => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(small))));
        await roundTrip(visitor);
        expect(visitor.ws.readyState).toBe(WebSocket.OPEN);
        expect(await storedText(doc.id)).toBe('');
    });
});

describe('the keepalive asks the link rule, and closes a visitor at the next tick', () => {
    test('a tick with nothing changed keeps the socket', async () => {
        const doc = await newPublicDoc();
        const visitor = await open(null, doc.id);
        await tick();
        await roundTrip(visitor);
        expect(visitor.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('another General access is saved', async () => {
        const doc = await newPublicDoc();
        const visitor = await open(null, doc.id);
        const member = await open(alice, doc.id);

        await setVisibility(doc.id, 'private');
        await tick();

        expect(await visitor.closed).toEqual(ACCESS_LOST);
        await roundTrip(member);
        expect(member.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('public links are turned off', async () => {
        const doc = await newPublicDoc();
        const visitor = await open(null, doc.id);
        const member = await open(alice, doc.id);

        await withPublicLinks(false);
        try {
            await tick();
            expect(await visitor.closed).toEqual(ACCESS_LOST);
            await roundTrip(member);
            expect(member.ws.readyState).toBe(WebSocket.OPEN);
        } finally {
            await withPublicLinks(true);
        }
    });

    test('the document is moved out of a public folder', async () => {
        const folder = await newFolder();
        const doc = await newDoc(folder.id);
        await setVisibility(folder.id, 'link');
        const visitor = await open(null, doc.id);

        await drivePut(alice.sessionToken, aliceId, mountId, `path/${doc.id}/move`, { targetParentId: root.id });
        await tick();

        expect(await visitor.closed).toEqual(ACCESS_LOST);
    });

    // The trash closes an open document itself, so the socket is gone before a tick. What the rule decides is the
    // reconnect, which a client makes at once.
    test('the document, or a folder above it, is trashed: the socket closes and a reconnect is refused', async () => {
        const folder = await newFolder();
        const inFolder = await newDoc(folder.id);
        await setVisibility(folder.id, 'link');
        const alone = await newPublicDoc();
        const visitors = [await open(null, inFolder.id), await open(null, alone.id)];

        await driveDelete(alice.sessionToken, aliceId, mountId, `path/${folder.id}`);
        await driveDelete(alice.sessionToken, aliceId, mountId, `path/${alone.id}`);
        await tick();

        for (const visitor of visitors) await visitor.closed;
        expect(await connect(null, inFolder.id).closed).toEqual(ACCESS_LOST);
        expect(await connect(null, alone.id).closed).toEqual(ACCESS_LOST);
    });
});

describe('a visitor leaves no trace, and the signed-in sockets beside it are as before', () => {
    test("no Recent row is written for a visitor's open", async () => {
        const doc = await newPublicDoc();
        await open(null, doc.id);
        // A signed-in open after it has its row, so the visitor's would have been written by now.
        await open(bob, doc.id);
        await eventually(async () => ((await recentIds(bob)).includes(doc.id) ? true : undefined), "bob's row");

        expect(await recentIds(alice)).not.toContain(doc.id);
        expect(await recentIds(ctx.charlie.user)).not.toContain(doc.id);
        expect((await recentIds(bob)).filter((id) => id === doc.id)).toEqual([doc.id]);
    });

    test('with a visitor connected, members share awareness both ways and a writer writes', async () => {
        const doc = await newPublicDoc();
        const visitor = await open(null, doc.id);
        const writer = await open(alice, doc.id);
        writer.ws.send(awarenessFrame(301, 1, presence(alice)));
        await roundTrip(writer);

        // Bob is signed in and no member, so the link lets him read, as under signed-in view.
        const reader = await open(bob, doc.id);
        await waitFor(() => reader.awareness.some((entry) => entry.clientId === 301), 5_000);
        reader.ws.send(awarenessFrame(302, 1, presence(bob)));
        await waitFor(() => writer.awareness.some((entry) => entry.clientId === 302), 5_000);

        write(writer, 'by the writer');
        await waitFor(() => reader.text() === 'by the writer' && visitor.text() === 'by the writer', 5_000);

        write(reader, 'by the reader');
        await roundTrip(reader);
        await roundTrip(writer);
        expect(writer.text()).toBe('by the writer');
        expect(visitor.awareness).toEqual([]);
    });
});

describe('the info route without a login', () => {
    function visit(pathId: string): Promise<Response> {
        return app.handle(new Request(`http://localhost/collab/${aliceId}/${mountId}/${pathId}/info`));
    }

    test('a public document answers its info, read-only, trimmed, with the visitor headers', async () => {
        const folder = await newFolder();
        const doc = await newDoc(folder.id);
        await setVisibility(doc.id, 'link');

        const res = await visit(doc.id);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-robots-tag')).toBe('noindex');
        const info = await assertJson<CollabDocumentInfo>(res);
        expect(info.canRead).toBe(true);
        expect(info.canWrite).toBe(false);
        expect(info.path?.id).toBe(doc.id);
        expect(info.path?.acl).toBeNull();
        expect(info.path?.parentId).toBe(folder.id);
        expect(info.folderContents?.map((child) => child.name)).toEqual(['media']);
    });

    test('a private document and an unknown id answer what a signed-in non-reader gets', async () => {
        const doc = await newDoc();
        for (const pathId of [doc.id, crypto.randomUUID()]) {
            expect(await assertJson(await visit(pathId))).toEqual(NO_INFO);
            const url = `/collab/${aliceId}/${mountId}/${pathId}/info`;
            expect(await assertJson(await authedRequest(bob.sessionToken, url))).toEqual(NO_INFO);
        }
    });

    test('with public links off a public document answers no read', async () => {
        const doc = await newPublicDoc();
        await withPublicLinks(false);
        try {
            expect(await assertJson(await visit(doc.id))).toEqual(NO_INFO);
        } finally {
            await withPublicLinks(true);
        }
    });

    test('a signed-in caller is answered as before', async () => {
        const folder = await newFolder();
        const doc = await newDoc(folder.id);
        await setVisibility(doc.id, 'link');
        const url = `/collab/${aliceId}/${mountId}/${doc.id}/info`;

        const ownerRes = await authedRequest(alice.sessionToken, url);
        expect(ownerRes.headers.get('cache-control')).not.toBe('no-store');
        expect(ownerRes.headers.get('x-robots-tag')).toBeNull();
        const owner = await assertJson<CollabDocumentInfo>(ownerRes);
        expect(owner.canRead).toBe(true);
        expect(owner.canWrite).toBe(true);
        expect(owner.path?.parentId).toBe(folder.id);
        expect(owner.folderContents?.map((child) => child.name).sort()).toEqual([
            'chat',
            'comments.db',
            'data.db',
            'media',
        ]);

        const reader = await assertJson<CollabDocumentInfo>(await authedRequest(bob.sessionToken, url));
        expect(reader.canRead).toBe(true);
        expect(reader.canWrite).toBe(false);
        expect(reader.path?.parentId).toBe(folder.id);
    });
});
