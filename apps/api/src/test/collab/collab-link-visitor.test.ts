import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { MAX_SYNC_STEP_1_BYTES } from '../../lib/collab/collab-document';
import { updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home/get-home';
import { waitFor } from '../fault-storage-helpers';
import type { TestUser } from '../setup';
import { app, assertJson, authedRequest, driveGet, drivePost, firstMountId, getTestContext } from '../setup';

// A collab document behind a public link: a request with no login gets its info and no socket, and a member's socket
// on it is as on any document. Needs a real listening server. A visitor is a request with no cookie. Each client here
// speaks y-websocket's handshake with y-protocols' own reader, as the browser does.

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const STEP_1 = syncProtocol.messageYjsSyncStep1;
const STEP_2 = syncProtocol.messageYjsSyncStep2;

const NO_INFO = { canRead: false, canWrite: false, path: null, folderContents: null };

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let alice: TestUser;
let bob: TestUser;
let aliceId: string;
let mountId: string;
let root: DrivePath;
let port: number | undefined;
const sockets = new Set<WebSocket>();

function withPublicLinks(on: boolean): Promise<void> {
    return updateServerSettings({ sharing: { publicLinks: on } });
}

beforeAll(async () => {
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
});

afterAll(() => {
    ctx.app.stop();
});

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

// The monotonic clock the server's step 1 budget reads: each call moves it a fixed step, and a jump moves it on. Timers
// still run on the real one.
function steppedClock(stepMs: number) {
    let now = performance.now();
    const spy = spyOn(performance, 'now').mockImplementation(() => {
        now += stepMs;
        return now;
    });
    return {
        calls: () => spy.mock.calls.length,
        jump: (ms: number) => {
            now += ms;
        },
        restore: () => spy.mockRestore(),
    };
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

// What a client that holds nothing sends, so the answer is the whole document.
function emptyStep1(): Uint8Array<ArrayBuffer> {
    return syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, new Y.Doc()));
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
    const doc = new Y.Doc();
    // Bun's WebSocket takes headers, which the DOM type the compiler sees does not know.
    const ws: WebSocket = Reflect.construct(WebSocket, [
        `ws://localhost:${port}/ws/collab/${aliceId}/${mountId}/${pathId}`,
        { headers: user ? { cookie: `better-auth.session_token=${user.sessionToken}` } : {} },
    ]);
    ws.binaryType = 'arraybuffer';
    sockets.add(ws);
    // The kind of each sync frame the server sent, every awareness state a peer published, and how many heartbeats
    // came: awareness frames with no state in them. The server's own state, which a member gets at sync, is empty.
    const syncFrames: number[] = [];
    const awareness: AwarenessEntry[] = [];
    let heartbeats = 0;

    let upgraded = false;
    ws.onopen = () => {
        upgraded = true;
        ws.send(syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, doc)));
    };
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
            const kind = syncProtocol.readSyncMessage(decoder, reply, doc, ws);
            syncFrames.push(kind);
            if (encoding.length(reply) > 1) ws.send(frameOf(reply));
        } else if (messageType === MESSAGE_AWARENESS) {
            const entries = decoding.createDecoder(decoding.readVarUint8Array(decoder));
            const count = decoding.readVarUint(entries);
            if (count === 0) heartbeats++;
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
    const text = () => doc.getText('probe').toString();
    return { ws, doc, closed, awareness, count, text, heartbeats: () => heartbeats, upgraded: () => upgraded };
}

type Client = ReturnType<typeof connect>;

// Resolves once the handshake is done: the server's step 2 arrived, and its step 1, which the client answered with its
// own step 2.
async function open(user: TestUser, pathId: string): Promise<Client> {
    const client = connect(user, pathId);
    await waitFor(() => client.count(STEP_2) > 0 && client.count(STEP_1) > 0, 10_000);
    return client;
}

// The server handles one socket's frames in order and sends in order, so once this step 1 is answered the server has
// handled every frame the client sent before it, and the client has every frame the server sent it before the answer.
async function roundTrip(client: Client): Promise<void> {
    const before = client.count(STEP_2);
    client.ws.send(syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, client.doc)));
    await waitFor(() => client.count(STEP_2) > before, 5_000);
}

// A refused upgrade never opens the socket, so the route's open never runs.
async function expectRefusedUpgrade(client: Client): Promise<void> {
    await client.closed;
    expect(client.upgraded()).toBe(false);
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

describe('a socket needs a login', () => {
    test('an upgrade without one is refused before open, on a public document as on a private one', async () => {
        const privateDoc = await newDoc();
        const publicDoc = await newPublicDoc();
        const member = await open(alice, publicDoc.id);
        for (const pathId of [publicDoc.id, privateDoc.id, crypto.randomUUID()]) {
            const res = await fetch(`http://localhost:${port}/ws/collab/${aliceId}/${mountId}/${pathId}`, {
                headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
            });
            expect(res.status).toBe(401);
            await expectRefusedUpgrade(connect(null, pathId));
        }
        // No visitor joined the open document.
        expect((await (await getHome(aliceId)).drive.getCollabDocument(mountId, publicDoc.id)).connectionCount).toBe(1);
        expect(member.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('with public links off too', async () => {
        const doc = await newPublicDoc();
        await withPublicLinks(false);
        try {
            await expectRefusedUpgrade(connect(null, doc.id));
        } finally {
            await withPublicLinks(true);
        }
    });
});

describe("a member's socket on a public document is as on any other", () => {
    test("it gets the server's step 1, and edits and awareness pass both ways", async () => {
        const doc = await newPublicDoc();
        const writer = await open(alice, doc.id);
        await roundTrip(writer);
        expect(writer.count(STEP_1)).toBe(1);
        writer.ws.send(awarenessFrame(301, 1, presence(alice)));
        await roundTrip(writer);

        // Bob is signed in and no member, so the link lets him read, as under signed-in view.
        const reader = await open(bob, doc.id);
        await waitFor(() => reader.awareness.some((entry) => entry.clientId === 301), 5_000);
        reader.ws.send(awarenessFrame(302, 1, presence(bob)));
        await waitFor(() => writer.awareness.some((entry) => entry.clientId === 302), 5_000);

        write(writer, 'by the writer');
        await waitFor(() => reader.text() === 'by the writer', 5_000);
        write(reader, 'by the reader');
        await roundTrip(reader);
        await roundTrip(writer);
        expect(writer.text()).toBe('by the writer');
        expect(await storedText(doc.id)).toBe('by the writer');
    });

    // An answer to an empty state vector is the whole document, so a document spends only a share of the event loop on
    // them. At 100 ms a clock call, an answer adds 1 s of debt and moves the clock 200 ms, so the fourth answer passes
    // the 2.5 s allowance and the six frames after it are dropped. The count of clock calls says all ten were handled.
    test('ten step 1 frames on two sockets get four answers, a later one is answered, another document is not held', async () => {
        const doc = await newPublicDoc();
        const other = await newPublicDoc();
        const clients = [await open(alice, doc.id), await open(alice, doc.id)];
        const answers = () => clients[0].count(STEP_2) + clients[1].count(STEP_2);
        const before = answers();
        const clock = steppedClock(100);
        try {
            for (let i = 0; i < 5; i++) {
                for (const client of clients) client.ws.send(emptyStep1());
            }
            await waitFor(() => clock.calls() === 4 * 2 + 6, 5_000);
            await waitFor(() => answers() === before + 4, 5_000);

            const stranger = await open(alice, other.id);
            expect(stranger.count(STEP_2)).toBe(1);

            clock.jump(10_000);
            for (const client of clients) await roundTrip(client);
            expect(answers()).toBe(before + 6);
            for (const client of clients) expect(client.ws.readyState).toBe(WebSocket.OPEN);
        } finally {
            clock.restore();
        }
    });

    test('a step 1 over the cap gets no answer, and the next one does', async () => {
        const doc = await newPublicDoc();
        // A well-formed state vector: client ids of five varuint bytes, each with a clock of 1.
        const entries = Math.ceil(MAX_SYNC_STEP_1_BYTES / 6) + 1;
        const vector = encoding.createEncoder();
        encoding.writeVarUint(vector, entries);
        for (let i = 0; i < entries; i++) {
            encoding.writeVarUint(vector, 2 ** 31 + i);
            encoding.writeVarUint(vector, 1);
        }
        const huge = syncFrame((encoder) => {
            encoding.writeVarUint(encoder, STEP_1);
            encoding.writeVarUint8Array(encoder, encoding.toUint8Array(vector));
        });
        expect(huge.byteLength).toBeGreaterThan(MAX_SYNC_STEP_1_BYTES);

        const client = await open(alice, doc.id);
        const before = client.count(STEP_2);
        client.ws.send(huge);
        // Frames are answered in order, so after this round trip an answer to the big one would have arrived.
        await roundTrip(client);
        expect(client.count(STEP_2)).toBe(before + 1);
        expect(client.ws.readyState).toBe(WebSocket.OPEN);
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
