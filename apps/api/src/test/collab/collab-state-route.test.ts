import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { applyCollabState } from '@workspace/lib/collab/collab-state';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { updateServerSettings } from '../../lib/config/server-settings';
import { getHome } from '../../lib/home/get-home';
import type { TestUser } from '../setup';
import {
    app,
    authedRequest,
    driveGet,
    driveGetList,
    drivePost,
    driveUpload,
    firstMountId,
    getTestContext,
} from '../setup';

// The state route: a document's stored rows over HTTP, for a reader who gets no socket. A member's edits arrive over a
// real socket, so the tests need a listening server. A visitor is a request with no cookie.

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let alice: TestUser;
let bob: TestUser;
let charlie: TestUser;
let aliceId: string;
let mountId: string;
let root: DrivePath;
let port: number | undefined;
const sockets = new Set<WebSocket>();

beforeAll(async () => {
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
});

afterAll(() => {
    ctx.app.stop();
});

async function putACL(pathId: string, body: object): Promise<void> {
    const res = await authedRequest(alice.sessionToken, `/drive/${aliceId}/${mountId}/path/${pathId}/acl`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
}

function newDoc(parentId = root.id): Promise<DrivePath> {
    return drivePost(alice.sessionToken, aliceId, mountId, `folder/${parentId}/create/doc`, {
        fileName: `State probe ${crypto.randomUUID()}`,
    });
}

async function newPublicDoc(): Promise<DrivePath> {
    const doc = await newDoc();
    await putACL(doc.id, { visibility: 'link' });
    return doc;
}

const stateUrl = (pathId: string) => `/collab/${aliceId}/${mountId}/${pathId}/state`;

function visit(pathId: string, etag?: string): Promise<Response> {
    return app.handle(
        new Request(`http://localhost${stateUrl(pathId)}`, { headers: etag ? { 'If-None-Match': etag } : {} }),
    );
}

// The document a reader holds after applying the body to an empty one.
async function docOf(res: Response): Promise<Y.Doc> {
    expect(res.status).toBe(200);
    const doc = new Y.Doc();
    applyCollabState(doc, await res.bytes(), null);
    return doc;
}

async function serverDoc(pathId: string): Promise<Y.Doc> {
    return (await (await getHome(aliceId)).drive.getCollabDocument(mountId, pathId)).doc;
}

async function isOpen(pathId: string): Promise<boolean> {
    return (await getHome(aliceId)).drive.hasCollabDocument(mountId, pathId);
}

// Alice's socket on the document. write() sends one update per call and resolves once the server's document holds it,
// which is when its row is stored too: the store runs in the same update event.
async function member(pathId: string) {
    // Bun's WebSocket takes headers, which the DOM type the compiler sees does not know.
    const ws: WebSocket = Reflect.construct(WebSocket, [
        `ws://localhost:${port}/ws/collab/${aliceId}/${mountId}/${pathId}`,
        { headers: { cookie: `better-auth.session_token=${alice.sessionToken}` } },
    ]);
    sockets.add(ws);
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    const doc = new Y.Doc();
    doc.on('update', (update: Uint8Array) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeUpdate(encoder, update);
        ws.send(new Uint8Array(encoding.toUint8Array(encoder)));
    });
    return async (text: string) => {
        doc.getText('probe').insert(doc.getText('probe').length, text);
        const stored = (await serverDoc(pathId)).getText('probe');
        while (stored.toString() !== doc.getText('probe').toString()) await Bun.sleep(5);
    };
}

describe('the stored rows rebuild the document', () => {
    test("a visitor's body gives the server's state, edits after the last snapshot and behind an open socket included", async () => {
        const doc = await newPublicDoc();
        const write = await member(doc.id);
        // The hundredth update folds the rows into a snapshot, so five updates follow it.
        for (let i = 0; i < 105; i++) await write(`${i},`);

        const held = await docOf(await visit(doc.id));
        const server = await serverDoc(doc.id);
        expect(held.getText('probe').toString()).toBe(server.getText('probe').toString());
        expect(Y.encodeStateAsUpdate(held)).toEqual(Y.encodeStateAsUpdate(server));

        // A newer body on top of the document a tab already holds brings it up to date.
        await write('later');
        applyCollabState(held, await (await visit(doc.id)).bytes(), null);
        expect(Y.encodeStateAsUpdate(held)).toEqual(Y.encodeStateAsUpdate(server));
    });

    test('a document nobody has open is answered from its rows and stays closed', async () => {
        const doc = await newPublicDoc();
        const write = await member(doc.id);
        await write('stored');
        for (const ws of sockets) ws.close();
        await (await getHome(aliceId)).drive.closeCollabDocument(mountId, doc.id);
        expect(await isOpen(doc.id)).toBe(false);

        const held = await docOf(await visit(doc.id));
        expect(held.getText('probe').toString()).toBe('stored');
        expect(await isOpen(doc.id)).toBe(false);
    });

    test('a new document answers an empty state', async () => {
        const doc = await newPublicDoc();
        const held = await docOf(await visit(doc.id));
        expect(held.getText('probe').toString()).toBe('');
        expect(await isOpen(doc.id)).toBe(false);
    });
});

describe('the ETag names the stored rows', () => {
    test('the same ETag answers 304 with no body, and one edit later 200 with another', async () => {
        const doc = await newPublicDoc();
        const write = await member(doc.id);
        await write('one');

        const first = await visit(doc.id);
        const etag = first.headers.get('etag') ?? '';
        expect(etag).toMatch(/^"[^"]+"$/);

        const unchanged = await visit(doc.id, etag);
        expect(unchanged.status).toBe(304);
        expect(unchanged.headers.get('etag')).toBe(etag);
        expect(unchanged.headers.get('cache-control')).toBe('no-store');
        expect((await unchanged.bytes()).byteLength).toBe(0);

        await write('two');
        const changed = await visit(doc.id, etag);
        expect(changed.headers.get('etag')).not.toBe(etag);
        expect((await docOf(changed)).getText('probe').toString()).toBe('onetwo');
    });

    test('a snapshot that replaces the updates changes it, and a close with nothing new does not', async () => {
        const doc = await newPublicDoc();
        const write = await member(doc.id);
        await write('one');
        const before = (await visit(doc.id)).headers.get('etag') ?? '';

        // The close folds the one update into a snapshot.
        for (const ws of sockets) ws.close();
        const { drive } = await getHome(aliceId);
        await drive.closeCollabDocument(mountId, doc.id);
        const folded = (await visit(doc.id)).headers.get('etag') ?? '';
        expect(folded).not.toBe(before);
        expect((await docOf(await visit(doc.id))).getText('probe').toString()).toBe('one');

        // An open and a close with no edit write no new snapshot.
        await drive.getCollabDocument(mountId, doc.id);
        await drive.closeCollabDocument(mountId, doc.id);
        expect((await visit(doc.id, folded)).status).toBe(304);
    });
});

describe('who is served', () => {
    test("a visitor's answer is binary and kept by no cache, and a signed-in caller's revalidates", async () => {
        const doc = await newPublicDoc();
        const visitor = await visit(doc.id);
        expect(visitor.headers.get('content-type')).toBe('application/octet-stream');
        expect(visitor.headers.get('cache-control')).toBe('no-store');
        expect(visitor.headers.get('x-robots-tag')).toBe('noindex');

        const owner = await authedRequest(alice.sessionToken, stateUrl(doc.id));
        expect(owner.headers.get('cache-control')).toBe('private, no-cache');
        expect(owner.headers.get('x-robots-tag')).toBeNull();
        expect(owner.headers.get('etag')).toBe(visitor.headers.get('etag'));
    });

    test('a signed-in non-member on an "Anyone signed in" document and a named reader are served', async () => {
        const signedIn = await newDoc();
        await putACL(signedIn.id, { visibility: 'public-read' });
        const named = await newDoc();
        await putACL(named.id, { add: [{ id: charlie.email, read: true, write: false }] });
        const write = await member(named.id);
        await write('for charlie');

        expect((await authedRequest(bob.sessionToken, stateUrl(signedIn.id))).status).toBe(200);
        // "Anyone signed in" is no link, so a request with no login is refused.
        expect((await visit(signedIn.id)).status).toBe(403);

        const held = await docOf(await authedRequest(charlie.sessionToken, stateUrl(named.id)));
        expect(held.getText('probe').toString()).toBe('for charlie');
        expect((await authedRequest(bob.sessionToken, stateUrl(named.id))).status).toBe(403);
    });
});

describe('what is refused, as the routes beside it refuse', () => {
    test('a private document and an unknown id: 403 for a visitor and for a signed-in non-member', async () => {
        const doc = await newDoc();
        for (const pathId of [doc.id, crypto.randomUUID()]) {
            expect((await visit(pathId)).status).toBe(403);
            expect((await authedRequest(bob.sessionToken, stateUrl(pathId))).status).toBe(403);
        }
    });

    test('a chat in a public folder: 403 for a visitor, and no document for its owner', async () => {
        const folder = await drivePost<DrivePath>(alice.sessionToken, aliceId, mountId, `folder/${root.id}`, {
            folderName: `State folder ${crypto.randomUUID()}`,
        });
        await putACL(folder.id, { visibility: 'link' });
        const chat = await drivePost<DrivePath>(
            alice.sessionToken,
            aliceId,
            mountId,
            `folder/${folder.id}/create/chat`,
            { fileName: `state-room-${crypto.randomUUID()}` },
        );
        expect((await visit(chat.id)).status).toBe(403);
        expect((await authedRequest(alice.sessionToken, stateUrl(chat.id))).status).toBe(404);
    });

    test('a public plain file and a public folder are no document: 404, for a visitor and the owner', async () => {
        const folder = await drivePost<DrivePath>(alice.sessionToken, aliceId, mountId, `folder/${root.id}`, {
            folderName: `State folder ${crypto.randomUUID()}`,
        });
        await putACL(folder.id, { visibility: 'link' });
        const file = await driveUpload(
            alice.sessionToken,
            aliceId,
            mountId,
            folder.id,
            new File(['plain'], 'plain.txt', { type: 'text/plain' }),
        );
        for (const pathId of [folder.id, file.id]) {
            expect((await visit(pathId)).status).toBe(404);
            expect((await authedRequest(alice.sessionToken, stateUrl(pathId))).status).toBe(404);
        }
    });

    test('a path inside a document is no document: its media folder 404, and its data.db 403 for a visitor', async () => {
        const doc = await newPublicDoc();
        const inside = await driveGetList(alice.sessionToken, aliceId, mountId, `folder/${doc.id}`);
        const media = inside.find((path) => path.name === 'media');
        const dataDb = inside.find((path) => path.name === 'data.db');
        if (!media || !dataDb) throw new Error('the container lacks its parts');

        expect((await visit(media.id)).status).toBe(404);
        expect((await visit(dataDb.id)).status).toBe(403);
        for (const pathId of [media.id, dataDb.id]) {
            expect((await authedRequest(alice.sessionToken, stateUrl(pathId))).status).toBe(404);
        }
    });

    test('with public links off a public document is refused', async () => {
        const doc = await newPublicDoc();
        await updateServerSettings({ sharing: { publicLinks: false } });
        try {
            expect((await visit(doc.id)).status).toBe(403);
        } finally {
            await updateServerSettings({ sharing: { publicLinks: true } });
        }
    });
});
