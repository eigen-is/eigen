import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { collabStateEpoch } from '@workspace/lib/collab/collab-state';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import * as schema from '../../lib/collab/schema';
import { updateServerSettings } from '../../lib/config/server-settings';
import { ApiError } from '../../lib/core/errors';
import * as collabSource from '../../lib/document/transform/collab-source';
import { BUSY_MESSAGE, documentTransformRunner } from '../../lib/document/transform/runner';
import { getDataEpoch } from '../../lib/home/data-epoch';
import { getHome } from '../../lib/home/get-home';
import { CONTAINER_DATA_DB } from '../../lib/mount/container-dbs';
import type { TestUser } from '../setup';
import {
    app,
    authedRequest,
    driveDelete,
    driveGet,
    driveGetList,
    drivePost,
    driveUpload,
    eventually,
    firstMountId,
    getTestContext,
} from '../setup';

// The state route: a document's state as one Yjs update, for a reader who gets no socket. A member's edits arrive over
// a real socket, so the tests need a listening server. A visitor is a request with no cookie.

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

function newFolder(): Promise<DrivePath> {
    return drivePost<DrivePath>(alice.sessionToken, aliceId, mountId, `folder/${root.id}`, {
        folderName: `State folder ${crypto.randomUUID()}`,
    });
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
    Y.applyUpdate(doc, await res.bytes());
    return doc;
}

async function serverDoc(pathId: string): Promise<Y.Doc> {
    return (await (await getHome(aliceId)).drive.getCollabDocument(mountId, pathId)).doc;
}

async function isOpen(pathId: string): Promise<boolean> {
    return (await getHome(aliceId)).drive.hasCollabDocument(mountId, pathId);
}

async function mountOf(pathId: string) {
    return (await (await getHome(aliceId)).drive.resolveFile(mountId, pathId)).mount;
}

async function cachedFiles(pathId: string): Promise<string[]> {
    return readdirSync((await mountOf(pathId)).previewsDir).filter((name) => name.startsWith(`${pathId}-`));
}

// Alice's socket on the document. Each edit is one update, and resolves once the server's document holds it, which is
// when its row is stored too: the store runs in the same update event.
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
    const edit = async (change: (held: Y.Doc) => void) => {
        change(doc);
        const stored = await serverDoc(pathId);
        const behind = () =>
            stored.getText('probe').toString() !== doc.getText('probe').toString() ||
            !Buffer.from(Y.encodeStateVector(stored)).equals(Buffer.from(Y.encodeStateVector(doc)));
        while (behind()) await Bun.sleep(5);
    };
    const write = (text: string) => edit((held) => held.getText('probe').insert(held.getText('probe').length, text));
    return { edit, write };
}

// The transform jobs the route enqueued, read off the runner's calls.
function stateJobs(run: ReturnType<typeof spyOn<typeof documentTransformRunner, 'run'>>) {
    return run.mock.calls.filter(([request]) => request.kind === 'collab-state');
}

describe('the body is the merged state', () => {
    test("a visitor's body is what a member's first sync carries, edits after the last snapshot and behind an open socket included", async () => {
        const doc = await newPublicDoc();
        const { write } = await member(doc.id);
        // The hundredth update folds the rows into a snapshot, so five updates follow it.
        for (let i = 0; i < 105; i++) await write(`${i},`);

        // A member's first sync is sync step 2 for an empty state vector: the server document's whole state.
        const held = await docOf(await visit(doc.id));
        const synced = new Y.Doc();
        Y.applyUpdate(synced, Y.encodeStateAsUpdate(await serverDoc(doc.id)));
        expect(held.getText('probe').toString()).toBe(synced.getText('probe').toString());
        expect(Y.encodeStateAsUpdate(held)).toEqual(Y.encodeStateAsUpdate(synced));

        // A newer body on top of the document a tab already holds brings it up to date.
        await write('later');
        Y.applyUpdate(held, await (await visit(doc.id)).bytes());
        expect(Y.encodeStateAsUpdate(held)).toEqual(Y.encodeStateAsUpdate(await serverDoc(doc.id)));
    });

    test('text the author deleted is not in the body, while a member holds the document open and before any snapshot', async () => {
        const doc = await newPublicDoc();
        const { edit } = await member(doc.id);
        await edit((held) => held.getText('probe').insert(0, 'hello SECRETPASSWORD world'));
        await edit((held) => held.getText('probe').delete('hello '.length, 'SECRETPASSWORD '.length));

        const res = await visit(doc.id);
        const body = Buffer.from(await res.bytes());
        expect(body.includes('SECRETPASSWORD')).toBe(false);
        expect(await isOpen(doc.id)).toBe(true);
        // No snapshot yet: the version's snapshot part is 0.
        expect(res.headers.get('etag')).toMatch(/\.0\.\d+\.[^.]+"$/);
        const held = new Y.Doc();
        Y.applyUpdate(held, body);
        expect(held.getText('probe').toString()).toBe('hello world');
    });

    test('a document nobody has open is answered from its rows and stays closed', async () => {
        const doc = await newPublicDoc();
        const { write } = await member(doc.id);
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

    test("a corrupt stored row is skipped, as a member's load skips it", async () => {
        const doc = await newPublicDoc();
        const { write } = await member(doc.id);
        await write('kept');
        for (const ws of sockets) ws.close();
        const { drive } = await getHome(aliceId);
        await drive.closeCollabDocument(mountId, doc.id);
        const mount = await mountOf(doc.id);
        const dataDb = await mount.getChildByName(doc.id, CONTAINER_DATA_DB);
        if (!dataDb) throw new Error('the container lacks its data.db');
        // The zstd magic and then nothing a decoder reads.
        await mount.withDatabase(COLLAB_DB_CONFIG, dataDb.id, async ({ db }) => {
            db.insert(schema.docUpdates)
                .values({ updateData: Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]) })
                .run();
        });

        expect((await docOf(await visit(doc.id))).getText('probe').toString()).toBe('kept');
        expect((await serverDoc(doc.id)).getText('probe').toString()).toBe('kept');
        await drive.closeCollabDocument(mountId, doc.id);
    });
});

describe('the ETag names the stored version', () => {
    test('the same ETag answers 304 with no body, and one edit later 200 with another', async () => {
        const doc = await newPublicDoc();
        const { write } = await member(doc.id);
        await write('one');

        const first = await visit(doc.id);
        const etag = first.headers.get('etag') ?? '';
        expect(etag).toMatch(/^"[^"]+"$/);
        expect(collabStateEpoch(etag)).toBe(getDataEpoch(aliceId));

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
        const { write } = await member(doc.id);
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

describe('one version is built once and then served from its file', () => {
    test('two requests for one version run one transform, and a later request or a 304 reads no blob', async () => {
        const doc = await newPublicDoc();
        const { write } = await member(doc.id);
        await write('once');
        const run = spyOn(documentTransformRunner, 'run');
        const capture = spyOn(collabSource, 'captureCollabSource');
        const captures = () => capture.mock.calls.filter(([, path]) => path.id === doc.id).length;
        try {
            const [first, second] = await Promise.all([visit(doc.id), visit(doc.id)]);
            expect([first.status, second.status]).toEqual([200, 200]);
            expect(await first.bytes()).toEqual(await second.bytes());
            expect(stateJobs(run).length).toBe(1);
            expect(captures()).toBe(1);

            const hit = await visit(doc.id);
            expect((await docOf(hit)).getText('probe').toString()).toBe('once');
            expect((await visit(doc.id, hit.headers.get('etag') ?? '')).status).toBe(304);
            expect(stateJobs(run).length).toBe(1);
            expect(captures()).toBe(1);
        } finally {
            run.mockRestore();
            capture.mockRestore();
        }
    });

    test("a miss runs in the background for whoever reads only through the link, and a named reader's in the foreground", async () => {
        const readers = [
            ['a visitor', null, 'background'],
            ['a signed-in non-member', bob.sessionToken, 'background'],
            ['a named reader', charlie.sessionToken, 'foreground'],
            ['the owner', alice.sessionToken, 'foreground'],
        ] as const;
        const docs = await Promise.all(
            readers.map(async () => {
                const doc = await newDoc();
                await putACL(doc.id, { visibility: 'link', add: [{ id: charlie.email, read: true, write: false }] });
                return doc;
            }),
        );
        const run = spyOn(documentTransformRunner, 'run');
        try {
            for (const [i, [who, token, expected]] of readers.entries()) {
                const res = token ? await authedRequest(token, stateUrl(docs[i].id)) : await visit(docs[i].id);
                expect([who, res.status]).toEqual([who, 200]);
                const priorities = stateJobs(run)
                    .splice(0)
                    .map(([, opts]) => opts.priority);
                run.mockClear();
                expect([who, priorities]).toEqual([who, [expected]]);
            }
        } finally {
            run.mockRestore();
        }
    });

    test('with the queue full a miss answers what a preview route answers', async () => {
        const doc = await newPublicDoc();
        const { write } = await member(doc.id);
        await write('busy');
        const admit = spyOn(documentTransformRunner, 'assertAdmissible').mockImplementation(() => {
            throw new ApiError(503, BUSY_MESSAGE);
        });
        try {
            const state = await visit(doc.id);
            const preview = await app.handle(
                new Request(`http://localhost/drive/${aliceId}/${mountId}/file/${doc.id}/text-preview`),
            );
            expect(state.status).toBe(503);
            expect(state.headers.get('etag')).toBeNull();
            expect([state.status, await state.text()]).toEqual([preview.status, await preview.text()]);
        } finally {
            admit.mockRestore();
        }
        expect((await visit(doc.id)).status).toBe(200);
    });

    test('a state file and a text preview of one document keep each other, and a newer state prunes the older', async () => {
        const doc = await newPublicDoc();
        const { edit, write } = await member(doc.id);
        // A doc's preview renders its body, so a paragraph gives it one.
        await edit((held) => {
            const paragraph = new Y.XmlElement('paragraph');
            paragraph.insert(0, [new Y.XmlText('first')]);
            held.getXmlFragment('default').insert(0, [paragraph]);
        });
        const older = await visit(doc.id);
        expect(older.status).toBe(200);
        const preview = await authedRequest(
            alice.sessionToken,
            `/drive/${aliceId}/${mountId}/file/${doc.id}/text-preview`,
        );
        expect(preview.status).toBe(200);
        const both = await eventually(async () => {
            const files = await cachedFiles(doc.id);
            return files.length === 2 ? files : undefined;
        }, 'a state file beside the text preview');
        expect(both.map((name) => name.split('.').at(-1)).sort()).toEqual(['json', 'yjs']);

        await write(' second');
        expect((await visit(doc.id)).status).toBe(200);
        const kept = await eventually(async () => {
            const files = await cachedFiles(doc.id);
            return files.length === 2 && !files.every((name) => both.includes(name)) ? files : undefined;
        }, 'the prune of the older state file');
        expect(kept.filter((name) => name.endsWith('.json'))).toEqual(both.filter((name) => name.endsWith('.json')));
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
        const { write } = await member(named.id);
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
        const folder = await newFolder();
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
        const folder = await newFolder();
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

    test('on a demo server a public document is refused', async () => {
        const doc = await newPublicDoc();
        process.env['EIGEN_DEMO'] = '1';
        try {
            expect((await visit(doc.id)).status).toBe(403);
        } finally {
            delete process.env['EIGEN_DEMO'];
        }
        expect((await visit(doc.id)).status).toBe(200);
    });

    test('a public document in the trash, or under a trashed folder, is refused', async () => {
        const trashed = await newPublicDoc();
        const folder = await newFolder();
        await putACL(folder.id, { visibility: 'link' });
        const below = await newDoc(folder.id);
        for (const doc of [trashed, below]) expect((await visit(doc.id)).status).toBe(200);

        await driveDelete(alice.sessionToken, aliceId, mountId, `path/${trashed.id}`);
        await driveDelete(alice.sessionToken, aliceId, mountId, `path/${folder.id}`);
        for (const doc of [trashed, below]) {
            expect((await visit(doc.id)).status).toBe(403);
            expect((await authedRequest(bob.sessionToken, stateUrl(doc.id))).status).toBe(403);
        }
    });
});
