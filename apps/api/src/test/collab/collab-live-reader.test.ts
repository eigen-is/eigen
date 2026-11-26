import type { Mock } from 'bun:test';
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { applyCollabState } from '@workspace/lib/collab/collab-state';
import { COLLAB_ACCESS_LOST_CLOSE, COLLAB_ACCESS_LOST_REASON } from '@workspace/lib/constants/collab';
import type { CollabDocumentInfo } from '@workspace/lib/types/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveACL, DriveVisibility } from '@workspace/lib/types/drive-access';
import { teamOwnerId } from '@workspace/lib/types/owner';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { MAX_SYNC_STEP_1_BYTES } from '../../lib/collab/collab-document';
import { getServerConfig } from '../../lib/config/server-config';
import { updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home/get-home';
import { waitFor } from '../fault-storage-helpers';
import type { TestUser } from '../setup';
import {
    addMember,
    app,
    assertJson,
    authedRequest,
    createTeam,
    createTestGuest,
    driveGet,
    drivePost,
    firstMountId,
    getTestContext,
} from '../setup';

// Who gets the collab socket: someone signed in who reads the document by name or may write it. A request with no
// login and a signed-in reader through a link or "Anyone signed in" get the document's info and no socket. Needs a real
// listening server. A visitor is a request with no cookie. Each client here speaks y-websocket's handshake with
// y-protocols' own reader, as the browser does. The tests run a keepalive tick by hand: the callback each socket gave
// setInterval, the real one, with no wait.

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const STEP_1 = syncProtocol.messageYjsSyncStep1;
const STEP_2 = syncProtocol.messageYjsSyncStep2;

const ACCESS_LOST = { code: COLLAB_ACCESS_LOST_CLOSE, reason: COLLAB_ACCESS_LOST_REASON };
const NO_INFO = { canRead: false, canWrite: false, live: false, path: null, folderContents: null };

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let alice: TestUser;
let bob: TestUser;
let charlie: TestUser;
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
    charlie = ctx.charlie.user;
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

async function putACL(pathId: string, body: { visibility?: DriveVisibility; add?: DriveACL[]; remove?: string[] }) {
    const res = await authedRequest(alice.sessionToken, `/drive/${aliceId}/${mountId}/path/${pathId}/acl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
}

function setVisibility(pathId: string, visibility: DriveVisibility): Promise<void> {
    return putACL(pathId, { visibility });
}

const viewer = (user: TestUser): DriveACL => ({ id: user.email, read: true, write: false });

async function newDocWith(body: Parameters<typeof putACL>[1]): Promise<DrivePath> {
    const doc = await newDoc();
    await putACL(doc.id, body);
    return doc;
}

// A team with bob in it, for a document shared with a team.
async function newTeamWithBob(): Promise<DriveACL> {
    const config = getServerConfig();
    if (!config) throw new Error('the server has no org');
    await authedRequest(alice.sessionToken, '/auth/organization/set-active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: config.orgId }),
    });
    const teamId = await createTeam(ctx, config.orgId, `Live ${crypto.randomUUID()}`);
    await addMember(ctx, teamId, bob.id);
    return { id: teamOwnerId(teamId), read: true, write: false };
}

const infoUrl = (pathId: string) => `/collab/${aliceId}/${mountId}/${pathId}/info`;
const stateUrl = (pathId: string) => `/collab/${aliceId}/${mountId}/${pathId}/state`;

async function infoOf(user: TestUser, pathId: string): Promise<CollabDocumentInfo> {
    return assertJson<CollabDocumentInfo>(await authedRequest(user.sessionToken, infoUrl(pathId)));
}

// What the stored state gives a reader who gets no socket.
async function textOverHttp(user: TestUser, pathId: string): Promise<string> {
    const res = await authedRequest(user.sessionToken, stateUrl(pathId));
    expect(res.status).toBe(200);
    const doc = new Y.Doc();
    applyCollabState(doc, await res.bytes(), null);
    return doc.getText('probe').toString();
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

// A socket the server closes as access lost, with no document content sent.
async function expectNoSocket(user: TestUser, pathId: string): Promise<void> {
    const client = connect(user, pathId);
    expect(await client.closed).toEqual(ACCESS_LOST);
    expect(client.count(STEP_2)).toBe(0);
    expect(client.text()).toBe('');
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

describe('who is live: signed in, and reading by name or allowed to write', () => {
    test('info answers live for an owner, a named reader, a team reader and "can edit", not for a link or "can view"', async () => {
        const view = await newDocWith({ visibility: 'public-read' });
        const edit = await newDocWith({ visibility: 'public-write' });
        const link = await newDocWith({ visibility: 'link' });
        const named = await newDocWith({ add: [viewer(charlie)] });
        const team = await newDocWith({ add: [await newTeamWithBob()] });
        const both = await newDocWith({ visibility: 'public-read', add: [viewer(charlie)] });

        const live = async (user: TestUser, doc: DrivePath) => {
            const info = await infoOf(user, doc.id);
            return info.canRead ? info.live : 'no read';
        };
        expect(await live(alice, view)).toBe(true);
        expect(await live(bob, view)).toBe(false);
        expect(await live(bob, edit)).toBe(true);
        expect(await live(bob, link)).toBe(false);
        expect(await live(charlie, named)).toBe(true);
        expect(await live(bob, named)).toBe('no read');
        expect(await live(bob, team)).toBe(true);
        expect(await live(charlie, team)).toBe('no read');
        expect(await live(charlie, both)).toBe(true);
        expect(await live(bob, both)).toBe(false);

        const res = await app.handle(new Request(`http://localhost${infoUrl(link.id)}`));
        const visitor = await assertJson<CollabDocumentInfo>(res);
        expect([visitor.canRead, visitor.live]).toEqual([true, false]);
    });

    test('a signed-in reader through "Anyone signed in, can view" or a link is refused the socket and loads over HTTP', async () => {
        for (const visibility of ['public-read', 'link'] as const) {
            const doc = await newDocWith({ visibility });
            const member = await open(alice, doc.id);
            write(member, 'hello');
            await roundTrip(member);

            await expectNoSocket(bob, doc.id);
            expect(await textOverHttp(bob, doc.id)).toBe('hello');
            expect(member.ws.readyState).toBe(WebSocket.OPEN);
        }
    });

    test('a named reader, a team reader and a signed-in person on "can edit" get the socket and sync', async () => {
        const named = await newDocWith({ add: [viewer(charlie)] });
        const team = await newDocWith({ add: [await newTeamWithBob()] });
        const edit = await newDocWith({ visibility: 'public-write' });

        for (const [user, doc, writes] of [
            [charlie, named, false],
            [bob, team, false],
            [bob, edit, true],
        ] as const) {
            const member = await open(alice, doc.id);
            write(member, 'hello');
            await roundTrip(member);

            const reader = await open(user, doc.id);
            expect(reader.text()).toBe('hello');
            write(member, ' world');
            await waitFor(() => reader.text() === 'hello world', 5_000);

            write(reader, '!');
            await roundTrip(reader);
            expect(await storedText(doc.id)).toBe(writes ? 'hello world!' : 'hello world');
        }
    });

    // An answer to an empty state vector is the whole document, and each is answered: the people on the socket are the
    // ones the document is shared with.
    test('a burst of step 1 frames from a named reader is all answered', async () => {
        const doc = await newDocWith({ add: [viewer(charlie)] });
        const reader = await open(charlie, doc.id);
        const before = reader.count(STEP_2);
        for (let i = 0; i < 10; i++) reader.ws.send(emptyStep1());
        await waitFor(() => reader.count(STEP_2) === before + 10, 5_000);
        expect(reader.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('a guest named as a viewer is live, with presence both ways, and the same guest on "can view" is not', async () => {
        const guest = await createTestGuest('Live Guest');
        const named = await newDocWith({ add: [viewer(guest)] });
        const view = await newDocWith({ visibility: 'public-read' });

        expect((await infoOf(guest, named.id)).live).toBe(true);
        const member = await open(alice, named.id);
        write(member, 'hello');
        member.ws.send(awarenessFrame(501, 1, presence(alice)));
        await roundTrip(member);

        const reader = await open(guest, named.id);
        expect(reader.text()).toBe('hello');
        await waitFor(() => reader.awareness.some((entry) => entry.clientId === 501), 5_000);
        reader.ws.send(awarenessFrame(502, 1, presence(guest)));
        await waitFor(() => member.awareness.some((entry) => entry.clientId === 502), 5_000);
        write(reader, 'by the guest');
        await roundTrip(reader);
        expect(await storedText(named.id)).toBe('hello');

        const info = await infoOf(guest, view.id);
        expect([info.canRead, info.live]).toEqual([true, false]);
        await expectNoSocket(guest, view.id);
        expect(await textOverHttp(guest, view.id)).toBe('');
    });

    test('a reader removed by name, whom "Anyone signed in" still lets read, loses the socket at the next tick', async () => {
        const doc = await newDocWith({ visibility: 'public-read', add: [viewer(charlie)] });
        const member = await open(alice, doc.id);
        write(member, 'kept');
        const reader = await open(charlie, doc.id);
        await tick();
        await roundTrip(reader);
        expect(reader.ws.readyState).toBe(WebSocket.OPEN);

        await putACL(doc.id, { remove: [charlie.email] });
        await tick();
        expect(await reader.closed).toEqual(ACCESS_LOST);

        const info = await infoOf(charlie, doc.id);
        expect([info.canRead, info.live]).toEqual([true, false]);
        expect(await textOverHttp(charlie, doc.id)).toBe('kept');
        await roundTrip(member);
        expect(member.ws.readyState).toBe(WebSocket.OPEN);
    });

    test("the server's step 1 is sent, and a step 1 over the cap gets no answer while the next one does", async () => {
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
        expect(client.count(STEP_1)).toBe(1);
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
        expect(reader.live).toBe(false);
        expect(reader.path?.parentId).toBe(folder.id);
    });
});
