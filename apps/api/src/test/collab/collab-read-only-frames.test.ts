import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import { docUpdates } from '../../lib/collab/schema';
import { getHome } from '../../lib/home/get-home';
import { waitFor } from '../fault-storage-helpers';
import type { TestUser } from '../setup';
import { createTestUser, driveGet, drivePost, firstMountId, getTestContext } from '../setup';

// A varuint has more than one encoding: 0x82 0x00 reads as 2, an update, but its first byte is 130. A reader's sync
// frame is judged by the type the server applies it as, so no spelling of a step 2 or an update gets a reader's edit
// into the document, to another socket or into data.db. Needs a real listening server.

const MESSAGE_SYNC = 0;

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let port: number | undefined;
let reader: TestUser;
const sockets = new Set<WebSocket>();

beforeAll(async () => {
    ctx = await getTestContext();
    reader = await createTestUser(`reader-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Reader');
    port = ctx.app.listen(0).server?.port;
});

afterEach(() => {
    for (const ws of sockets) ws.close();
    sockets.clear();
});

afterAll(() => {
    ctx.app.stop();
});

// A doc in alice's Home that the reader may view but not edit.
async function sharedDoc(): Promise<string> {
    const owner = ctx.alice.user;
    const mountId = await firstMountId(owner.sessionToken, owner.id);
    const root = await driveGet<DrivePath>(owner.sessionToken, owner.id, mountId, 'root');
    const doc = await drivePost<DrivePath>(owner.sessionToken, owner.id, mountId, `folder/${root.id}/create/doc`, {
        fileName: `Read-only frames ${crypto.randomUUID()}`,
    });
    await (await getHome(owner.id)).drive.updateACLDelta(mountId, doc.id, {
        add: [{ id: reader.email, read: true, write: false }],
    });
    return doc.id;
}

// Resolves once the server's sync step 1 arrived, so the socket is subscribed. Keeps every sync frame it gets.
async function openSocket(user: TestUser, docId: string) {
    const owner = ctx.alice.user;
    const mountId = await firstMountId(owner.sessionToken, owner.id);
    // Bun's WebSocket takes headers, which the DOM type the compiler sees does not know.
    const ws: WebSocket = Reflect.construct(WebSocket, [
        `ws://localhost:${port}/ws/collab/${owner.id}/${mountId}/${docId}`,
        { headers: { cookie: `better-auth.session_token=${user.sessionToken}` } },
    ]);
    ws.binaryType = 'arraybuffer';
    sockets.add(ws);
    const syncFrames: { type: number; payload: Uint8Array }[] = [];
    ws.onmessage = ({ data }) => {
        if (!(data instanceof ArrayBuffer)) return;
        const decoder = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
        syncFrames.push({ type: decoding.readVarUint(decoder), payload: decoding.readVarUint8Array(decoder) });
    };
    await waitFor(() => syncFrames.some((frame) => frame.type === syncProtocol.messageYjsSyncStep1), 10_000);
    return { ws, syncFrames, mountId };
}

type Socket = Awaited<ReturnType<typeof openSocket>>;

// A sync frame whose type is spelled with the given bytes, so a test can send a varuint in an over-long form.
function syncFrame(typeBytes: number[], payload: Uint8Array): Uint8Array<ArrayBuffer> {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    for (const byte of typeBytes) encoding.writeUint8(encoder, byte);
    encoding.writeVarUint8Array(encoder, payload);
    return new Uint8Array(encoding.toUint8Array(encoder));
}

function edit(value: string): Uint8Array {
    const doc = new Y.Doc();
    doc.getMap('probe').set('k', value);
    return Y.encodeStateAsUpdate(doc);
}

// Sends a step 1 with an empty state vector and returns the document its step 2 reply holds. On the sender's own
// socket the reply also shows that every frame it sent before was handled.
async function syncedDoc(socket: Socket, typeBytes = [0]): Promise<Y.Doc> {
    const before = socket.syncFrames.length;
    socket.ws.send(syncFrame(typeBytes, Y.encodeStateVector(new Y.Doc())));
    await waitFor(
        () => socket.syncFrames.slice(before).some((frame) => frame.type === syncProtocol.messageYjsSyncStep2),
        5_000,
    );
    const reply = socket.syncFrames.slice(before).find((frame) => frame.type === syncProtocol.messageYjsSyncStep2);
    const doc = new Y.Doc();
    if (reply) Y.applyUpdate(doc, reply.payload);
    return doc;
}

async function storedUpdateCount(docId: string): Promise<number> {
    const home = await getHome(ctx.alice.user.id);
    const mountId = await firstMountId(ctx.alice.user.sessionToken, ctx.alice.user.id);
    const document = await home.drive.getCollabDocument(mountId, docId);
    return home.drive.withDatabase(
        mountId,
        COLLAB_DB_CONFIG,
        document.dataDbPathId,
        async (managedDb) => managedDb.db.select().from(docUpdates).all().length,
    );
}

describe("a reader's step 2 or update changes nothing, however its type is spelled", () => {
    test.each([
        ['an update', [2]],
        ['an update, type as 0x82 0x00', [0x82, 0x00]],
        ['an update, type as 0x82 0x80 0x00', [0x82, 0x80, 0x00]],
        ['a step 2', [1]],
        ['a step 2, type as 0x81 0x00', [0x81, 0x00]],
        ['a step 2, type as 0x81 0x80 0x00', [0x81, 0x80, 0x00]],
    ])('%s', async (_label, typeBytes) => {
        const docId = await sharedDoc();
        const watcher = await openSocket(ctx.alice.user, docId);
        const readerSocket = await openSocket(reader, docId);
        const storedBefore = await storedUpdateCount(docId);

        readerSocket.ws.send(syncFrame(typeBytes, edit('reader')));
        await syncedDoc(readerSocket);
        const fresh = await syncedDoc(await openSocket(ctx.alice.user, docId));

        expect({
            content: fresh.getMap('probe').get('k'),
            updatesToWatcher: watcher.syncFrames.filter((frame) => frame.type === syncProtocol.messageYjsUpdate).length,
            stored: await storedUpdateCount(docId),
        }).toEqual({ content: undefined, updatesToWatcher: 0, stored: storedBefore });
    });
});

describe('the handshake and a writer still work', () => {
    test.each([
        ['canonical', [0]],
        ['type as 0x80 0x00', [0x80, 0x00]],
    ])("a reader's step 1, %s, is answered with the content", async (_label, typeBytes) => {
        const docId = await sharedDoc();
        const writer = await openSocket(ctx.alice.user, docId);
        writer.ws.send(syncFrame([syncProtocol.messageYjsUpdate], edit('writer')));
        await syncedDoc(writer);

        const synced = await syncedDoc(await openSocket(reader, docId), typeBytes);
        expect(synced.getMap('probe').get('k')).toBe('writer');
    });

    test.each([
        ['an update', syncProtocol.messageYjsUpdate],
        ['a step 2', syncProtocol.messageYjsSyncStep2],
    ])("a writer's %s applies and reaches the other sockets", async (_label, type) => {
        const docId = await sharedDoc();
        const writer = await openSocket(ctx.alice.user, docId);
        const readerSocket = await openSocket(reader, docId);

        writer.ws.send(syncFrame([type], edit('writer')));
        await waitFor(
            () => readerSocket.syncFrames.some((frame) => frame.type === syncProtocol.messageYjsUpdate),
            5_000,
        );
        const fresh = await syncedDoc(await openSocket(ctx.alice.user, docId));
        expect(fresh.getMap('probe').get('k')).toBe('writer');
    });
});
