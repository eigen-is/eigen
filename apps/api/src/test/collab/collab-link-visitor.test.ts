import type { Mock } from 'bun:test';
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { COLLAB_ACCESS_LOST_CLOSE, COLLAB_ACCESS_LOST_REASON } from '@workspace/lib/constants/collab';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { MAX_SYNC_STEP_1_BYTES, SYNC_STEP_1_INTERVAL_MS } from '../../lib/collab/collab-document';
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

// Each round trip waits out the server's step 1 interval, so a test with a few of them outlasts the default.
setDefaultTimeout(30_000);

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
// what the server sends and sends its own edits as updates. No user means no cookie. A client that reconnects brings
// the document it holds.
function connect(user: TestUser | null, pathId: string, doc = new Y.Doc(), ownerId = aliceId) {
    // Bun's WebSocket takes headers, which the DOM type the compiler sees does not know.
    const ws: WebSocket = Reflect.construct(WebSocket, [
        `ws://localhost:${port}/ws/collab/${ownerId}/${mountId}/${pathId}`,
        { headers: user ? { cookie: `better-auth.session_token=${user.sessionToken}` } : {} },
    ]);
    ws.binaryType = 'arraybuffer';
    sockets.add(ws);
    // The kind of each sync frame the server sent, and every awareness state a peer published. The loading heartbeat
    // is an awareness frame with no state in it, and the server's own state, which a member gets at sync, is empty.
    const syncFrames: number[] = [];
    const awareness: AwarenessEntry[] = [];
    // When the server's last step 2, its answer to a step 1, arrived.
    let answeredAt = 0;
    let pongs = 0;

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
        if (data === 'pong') pongs++;
        if (!(data instanceof ArrayBuffer)) return;
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const messageType = decoding.readVarUint(decoder);
        if (messageType === MESSAGE_SYNC) {
            const reply = encoding.createEncoder();
            encoding.writeVarUint(reply, MESSAGE_SYNC);
            const kind = syncProtocol.readSyncMessage(decoder, reply, doc, ws);
            syncFrames.push(kind);
            if (kind === STEP_2) answeredAt = Date.now();
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
    const text = () => doc.getText('probe').toString();
    // Resolves once the server would answer this socket's next step 1.
    const paced = () => Bun.sleep(Math.max(0, answeredAt + SYNC_STEP_1_INTERVAL_MS + 10 - Date.now()));
    return { ws, doc, closed, awareness, count, text, paced, pongs: () => pongs, upgraded: () => upgraded };
}

type Client = ReturnType<typeof connect>;

// Resolves once the handshake is done: the server's step 2 arrived, and for a member also its step 1, which the client
// answered with its own step 2. A visitor gets no step 1.
async function open(user: TestUser | null, pathId: string, doc?: Y.Doc): Promise<Client> {
    const client = connect(user, pathId, doc);
    await waitFor(() => client.count(STEP_2) > 0 && (user === null || client.count(STEP_1) > 0), 10_000);
    return client;
}

// The server handles one socket's frames in order and sends in order, so once this step 1 is answered the server has
// handled every frame the client sent before it, and the client has every frame the server sent it before the answer.
// The server answers a socket's step 1 at most once per interval, so it waits that out first.
async function roundTrip(client: Client): Promise<void> {
    await client.paced();
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

async function recentIds(user: TestUser): Promise<string[]> {
    const sharedDb = await getSharedDatabase(await getHome(user.id));
    return sharedDb
        .select()
        .from(recentPaths)
        .all()
        .map((row) => row.pathId);
}

describe('a socket without a login opens what a public link opens', () => {
    test('a public document: the visitor gets no step 1, syncs from its own, and a later edit reaches it', async () => {
        const doc = await newPublicDoc();
        const member = await open(alice, doc.id);
        write(member, 'hello');
        await roundTrip(member);

        const visitor = await open(null, doc.id);
        expect(visitor.text()).toBe('hello');
        await roundTrip(visitor);
        expect(visitor.count(STEP_1)).toBe(0);
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

    // An answer to an empty state vector is the whole document, so a burst would hold the event loop.
    test('a burst of step 1 frames gets one answer, the next after the interval another, for a member and a visitor', async () => {
        const doc = await newPublicDoc();
        for (const user of [alice, null]) {
            const client = await open(user, doc.id);
            await client.paced();
            const before = client.count(STEP_2);
            for (let i = 0; i < 50; i++) {
                client.ws.send(syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, new Y.Doc())));
            }
            await waitFor(() => client.count(STEP_2) === before + 1, 5_000);
            await roundTrip(client);
            expect(client.count(STEP_2)).toBe(before + 2);
            expect(client.ws.readyState).toBe(WebSocket.OPEN);
        }
    });

    test("another socket's first step 1 is answered at once", async () => {
        const doc = await newPublicDoc();
        for (const user of [alice, null]) {
            const first = await open(user, doc.id);
            const start = Date.now();
            const second = await open(user, doc.id);
            expect(Date.now() - start).toBeLessThan(SYNC_STEP_1_INTERVAL_MS);
            expect(second.count(STEP_2)).toBe(1);
            await roundTrip(first);
        }
    });

    test('a step 1 over the cap gets no answer, for a member and a visitor, and the next one does', async () => {
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

        for (const user of [alice, null]) {
            const client = await open(user, doc.id);
            await client.paced();
            const before = client.count(STEP_2);
            client.ws.send(huge);
            // Frames are answered in order, so after this round trip an answer to the big one would have arrived.
            await roundTrip(client);
            expect(client.count(STEP_2)).toBe(before + 1);
            expect(client.ws.readyState).toBe(WebSocket.OPEN);
        }
    });

    // Every other text frame is dropped unread, and Elysia hands it over unparsed (collab-ws-text-frames.test.ts).
    test('ping gets its pong after a few MB of JSON in a text frame, for a member and a visitor', async () => {
        const doc = await newPublicDoc();
        const json = `[${'0,'.repeat(2 * 1024 * 1024)}0]`;
        for (const user of [alice, null]) {
            const client = await open(user, doc.id);
            client.ws.send(json);
            client.ws.send('ping');
            await waitFor(() => client.pongs() === 1, 5_000);
            await roundTrip(client);
            expect(client.ws.readyState).toBe(WebSocket.OPEN);
        }
    });

    test("a member's socket gets the server's step 1", async () => {
        const doc = await newPublicDoc();
        const member = await open(alice, doc.id);
        await roundTrip(member);
        expect(member.count(STEP_1)).toBe(1);
    });

    // Every other character deleted leaves a delete set of one range per character, and a step 2 carries it whole.
    test('a visitor that reconnects holding a much-deleted document stays open and gets the next edit', async () => {
        const doc = await newPublicDoc();
        const member = await open(alice, doc.id);
        const text = member.doc.getText('probe');
        text.insert(0, 'ab'.repeat(40_000));
        member.doc.transact(() => {
            for (let i = 40_000 - 1; i >= 0; i--) text.delete(2 * i + 1, 1);
        });
        await roundTrip(member);

        const first = await open(null, doc.id);
        expect(first.text()).toBe('a'.repeat(40_000));
        first.ws.close();
        await first.closed;
        const held = syncFrame((encoder) => syncProtocol.writeSyncStep2(encoder, first.doc));
        expect(held.byteLength).toBeGreaterThan(100 * 1024);

        const visitor = await open(null, doc.id, first.doc);
        write(member, '!');
        await waitFor(() => visitor.text().endsWith('!'), 5_000);
        await roundTrip(visitor);
        expect(visitor.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('a private document, an unknown id, a chat and an unknown owner refuse the upgrade', async () => {
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
            await expectRefusedUpgrade(connect(null, pathId));
        }
        const publicDoc = await newPublicDoc();
        await expectRefusedUpgrade(connect(null, publicDoc.id, new Y.Doc(), 'a'.repeat(32)));
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

    test('with public links off a public document refuses the upgrade', async () => {
        const doc = await newPublicDoc();
        await withPublicLinks(false);
        try {
            await expectRefusedUpgrade(connect(null, doc.id));
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

describe('a visitor writes nothing, and its socket stays', () => {
    test('its step 2 and update over 100 KB leave the document unchanged, and a member sends the same', async () => {
        const doc = await newPublicDoc();
        const member = await open(alice, doc.id);
        write(member, 'kept');
        await roundTrip(member);

        const big = new Y.Doc();
        big.getText('probe').insert(0, 'x'.repeat(100 * 1024));
        const step2 = syncFrame((encoder) => syncProtocol.writeSyncStep2(encoder, big));
        const update = syncFrame((encoder) => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(big)));
        expect(Math.min(step2.byteLength, update.byteLength)).toBeGreaterThan(100 * 1024);

        const visitor = await open(null, doc.id);
        visitor.ws.send(step2);
        visitor.ws.send(update);
        await roundTrip(visitor);
        expect(visitor.ws.readyState).toBe(WebSocket.OPEN);
        await roundTrip(member);
        expect(member.text()).toBe('kept');
        expect(await storedText(doc.id)).toBe('kept');

        member.ws.send(update);
        await roundTrip(member);
        expect((await storedText(doc.id)).length).toBe('kept'.length + 100 * 1024);
        expect(visitor.ws.readyState).toBe(WebSocket.OPEN);
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
        await expectRefusedUpgrade(connect(null, inFolder.id));
        await expectRefusedUpgrade(connect(null, alone.id));
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
