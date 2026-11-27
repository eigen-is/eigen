import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath, DrivePathType } from '@workspace/lib/types/drive';
import { teamOwnerId } from '@workspace/lib/types/owner';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { updateServerSettings } from '../../lib/config/server-settings';
import { canReadFromAncestors, isRawDatabase } from '../../lib/drive/acl';
import { getHome } from '../../lib/home/get-home';
import { Mount } from '../../lib/mount';
import type { User } from '../../lib/user';
import { getUserByEmail } from '../../lib/user';
import type { TestUser } from '../setup';
import {
    authedRequest,
    chatPost,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    firstMountId,
    getTestContext,
    TEST_PNG_BYTES,
} from '../setup';
import { webdavRequest } from '../webdav/setup';

// A container's raw databases, such as a document's data.db with every edit and deleted text in it, are read only by
// a live reader. Charlie reads the folder only through its link, so he is not live; Bob reads it by name.

let alice: TestUser;
let bob: TestUser;
let charlie: TestUser;
let mountId: string;
let port: number | undefined;
let ctx: Awaited<ReturnType<typeof getTestContext>>;
const sockets = new Set<WebSocket>();

const SECRET = `DELETED-${crypto.randomUUID()}`;
const drive = (...parts: string[]) => [`/drive/${alice.id}/${mountId}`, ...parts].join('/');

// A folder with a link that Bob reads by name, holding a document whose text had a secret its author deleted, a picture
// in its media/, and a comment thread with an attachment.
type Fixture = {
    folder: DrivePath;
    doc: DrivePath;
    picture: DrivePath;
    png: DrivePath;
    chatFolder: DrivePath;
    thread: DrivePath;
    attachment: DrivePath;
    versions: DrivePath;
    // The databases, as the owner lists them: the document's data.db and comments.db, the thread's data.db and a saved
    // version, which holds the deleted text.
    databases: DrivePath[];
};
let fx: Fixture;

async function childrenOf(token: string, folderId: string): Promise<DrivePath[]> {
    const res = await authedRequest(token, drive('folder', folderId));
    expect(res.status).toBe(200);
    return res.json();
}

function named(children: readonly DrivePath[], name: string): DrivePath {
    const found = children.find((child) => child.name === name);
    if (!found) throw new Error(`No ${name} among ${children.map((child) => child.name).join(', ')}`);
    return found;
}

// Charlie's copy of one of Alice's paths into his own home.
async function charlieCopies(pathId: string): Promise<Response> {
    const home = await driveGet(
        charlie.sessionToken,
        charlie.id,
        await firstMountId(charlie.sessionToken, charlie.id),
        'root',
    );
    return authedRequest(charlie.sessionToken, drive('path', pathId, 'copy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetOwnerId: charlie.id, targetMountId: home.mountId, targetParentId: home.id }),
    });
}

// Alice's edit over a real socket, so its row is stored as a member's is. Resolves once the server's document holds it.
async function aliceEdits(docId: string, change: (doc: Y.Doc) => void): Promise<void> {
    const ws: WebSocket = Reflect.construct(WebSocket, [
        `ws://localhost:${port}/ws/collab/${alice.id}/${mountId}/${docId}`,
        { headers: { cookie: `better-auth.session_token=${alice.sessionToken}` } },
    ]);
    sockets.add(ws);
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    const doc = new Y.Doc();
    const server = (await (await getHome(alice.id)).drive.getCollabDocument(mountId, docId)).doc;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    doc.on('update', (update: Uint8Array) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        syncProtocol.writeUpdate(encoder, update);
        ws.send(new Uint8Array(encoding.toUint8Array(encoder)));
    });
    change(doc);
    while (server.getText('probe').toString() !== doc.getText('probe').toString()) await Bun.sleep(5);
}

beforeAll(async () => {
    ctx = await getTestContext();
    ({ alice, bob, charlie } = { alice: ctx.alice.user, bob: ctx.bob.user, charlie: ctx.charlie.user });
    mountId = await firstMountId(alice.sessionToken, alice.id);
    port = ctx.app.listen(0).server?.port;
    await updateServerSettings({ sharing: { publicLinks: true } });
    const root = await driveGet(alice.sessionToken, alice.id, mountId, 'root');
    const token = alice.sessionToken;
    const folder = await drivePost(token, alice.id, mountId, `folder/${root.id}`, {
        folderName: `Raw ${crypto.randomUUID()}`,
    });
    await drivePut(token, alice.id, mountId, `path/${folder.id}/acl`, {
        visibility: 'link',
        add: [{ id: bob.email, read: true, write: false }],
    });
    const doc = await drivePost(token, alice.id, mountId, `folder/${folder.id}/create/doc`, { fileName: 'Notes' });
    await aliceEdits(doc.id, (held) => held.getText('probe').insert(0, `keep ${SECRET} tail`));
    await drivePost(token, alice.id, mountId, `file/${doc.id}/versions/save`, {});
    await aliceEdits(doc.id, (held) => held.getText('probe').delete(5, SECRET.length));
    const parts = await childrenOf(token, doc.id);
    const media = named(parts, 'media');
    const chatFolder = named(parts, 'chat');
    const picture = await driveUpload(
        token,
        alice.id,
        mountId,
        media.id,
        new File([TEST_PNG_BYTES], 'pic.png', { type: 'image/png' }),
    );
    const png = await driveUpload(
        token,
        alice.id,
        mountId,
        folder.id,
        new File([TEST_PNG_BYTES], 'plain.png', { type: 'image/png' }),
    );
    const thread = await drivePost(token, alice.id, mountId, `folder/${chatFolder.id}/create/chat`, {
        fileName: 'thread-1',
    });
    await chatPost(token, alice.id, mountId, `${thread.id}/messages`, { content: 'a reply' });
    const threadMedia = named(await childrenOf(token, thread.id), 'media');
    const attachment = await driveUpload(
        token,
        alice.id,
        mountId,
        threadMedia.id,
        new File([TEST_PNG_BYTES], 'att.png', { type: 'image/png' }),
    );
    await (await getHome(alice.id)).drive.flushContainerDb(mountId, doc.id);
    const versions = named(await childrenOf(token, doc.id), 'versions');
    const [version] = await childrenOf(token, versions.id);
    const databases = [
        named(parts, 'data.db'),
        named(parts, 'comments.db'),
        named(await childrenOf(token, thread.id), 'data.db'),
        version,
    ];
    fx = { folder, doc, picture, png, chatFolder, thread, attachment, versions, databases };
}, 60_000);

afterAll(() => {
    for (const ws of sockets) ws.close();
    ctx.app.stop();
});

describe('a reader who is not live', () => {
    test('lists a document, a thread and the saved versions without their databases', async () => {
        const docNames = (await childrenOf(charlie.sessionToken, fx.doc.id)).map((child) => child.name);
        expect(docNames.sort()).toEqual(['chat', 'media', 'versions']);
        expect(await childrenOf(charlie.sessionToken, fx.versions.id)).toEqual([]);
        const threadNames = (await childrenOf(charlie.sessionToken, fx.thread.id)).map((child) => child.name);
        expect(threadNames).toEqual(['media']);
        const info = await (
            await authedRequest(charlie.sessionToken, `/collab/${alice.id}/${mountId}/${fx.doc.id}/info`)
        ).json();
        expect(info.folderContents.map((child: DrivePath) => child.name).sort()).toEqual(['chat', 'media', 'versions']);
    });

    test('is refused every read of a database, by id and over WebDAV', async () => {
        for (const db of fx.databases) {
            for (const route of [
                drive('path', db.id),
                drive('file', db.id, 'download'),
                drive('file', db.id, 'preview'),
                drive('file', db.id, 'text-preview'),
                drive('file', db.id, 'embed', db.name),
                drive('thumb', `${db.id}.webp`),
            ]) {
                const res = await authedRequest(charlie.sessionToken, route);
                expect([route, res.status]).toEqual([route, 403]);
            }
            const crumbs = await authedRequest(charlie.sessionToken, drive('path', db.id, 'breadcrumb'));
            expect(await crumbs.json()).toEqual([]);
            const permissions = await (
                await authedRequest(charlie.sessionToken, drive('path', db.id, 'permissions'))
            ).json();
            expect(permissions.canRead).toBe(false);
        }
        const dav = `/webdav/${alice.id}/${mountId}/${fx.folder.name}/${fx.doc.name}`;
        expect((await webdavRequest(charlie.email, 'GET', `${dav}/data.db`)).status).toBe(404);
        const listing = await webdavRequest(charlie.email, 'PROPFIND', `${dav}/`, { headers: { Depth: '1' } });
        expect(listing.status).toBe(207);
        const body = await listing.text();
        expect(body).toContain('media');
        expect(body).not.toContain('data.db');
        expect(body).not.toContain('comments.db');
    });

    test('cannot copy a document, a folder holding one, its saved versions or a database, and still copies a plain file', async () => {
        for (const pathId of [
            fx.doc.id,
            fx.folder.id,
            fx.thread.id,
            fx.versions.id,
            ...fx.databases.map((db) => db.id),
        ]) {
            const res = await charlieCopies(pathId);
            expect([pathId, res.status]).toEqual([pathId, 403]);
        }
        expect(await (await charlieCopies(fx.doc.id)).text()).toContain(
            'Only people with access can copy this document',
        );
        expect((await charlieCopies(fx.png.id)).status).toBe(200);
        expect((await charlieCopies(fx.picture.id)).status).toBe(200);
    });

    test('cannot copy a document that lands in the folder while the copy lists it', async () => {
        const token = alice.sessionToken;
        const folder = await drivePost(token, alice.id, mountId, `folder/${fx.folder.id}`, {
            folderName: `Empty ${crypto.randomUUID()}`,
        });
        const listCopy = Mount.prototype.listCopy;
        // What the late document held as the copy listed it, asserted after the request so a miss fails the test.
        let lateParts: string[] = [];
        const spy = spyOn(Mount.prototype, 'listCopy').mockImplementationOnce(async function (this: Mount, pathId) {
            const doc = await drivePost(token, alice.id, mountId, `folder/${folder.id}/create/doc`, {
                fileName: 'Late',
            });
            lateParts = (await childrenOf(token, doc.id)).map((child) => child.name);
            return listCopy.call(this, pathId);
        });
        try {
            const res = await charlieCopies(folder.id);
            expect(res.status).toBe(403);
            expect(await res.text()).toContain('Only people with access can copy this document');
            expect(lateParts).toContain('data.db');
            expect(spy).toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    // Charlie may write the folder by name, but reads the document only through its link, so he is not live there.
    test('cannot WebDAV COPY a document over a file, and the file stays where it was', async () => {
        const token = alice.sessionToken;
        const root = await driveGet(token, alice.id, mountId, 'root');
        const name = `Writable-${crypto.randomUUID()}`;
        const target = await drivePost(token, alice.id, mountId, `folder/${root.id}`, { folderName: name });
        await drivePut(token, alice.id, mountId, `path/${target.id}/acl`, {
            add: [{ id: charlie.email, read: true, write: true }],
        });
        const dav = `/webdav/${alice.id}/${mountId}`;
        const kept = `${dav}/${name}/keep.txt`;
        expect((await webdavRequest(charlie.email, 'PUT', kept, { body: 'old' })).status).toBe(201);
        const res = await webdavRequest(charlie.email, 'COPY', `${dav}/${fx.folder.name}/${fx.doc.name}`, {
            headers: { Destination: `http://localhost${kept}`, Overwrite: 'T' },
        });
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('Only people with access can copy this document');
        expect(await (await webdavRequest(charlie.email, 'GET', kept)).text()).toBe('old');
        const trash = await (await getHome(alice.id)).drive.listTrash(mountId);
        expect(trash.map((path) => path.name)).not.toContain('keep.txt');
    });

    test('still opens the document, its pictures, comments, threads, history, export and members', async () => {
        const as = (route: string) => authedRequest(charlie.sessionToken, route);
        const state = await as(`/collab/${alice.id}/${mountId}/${fx.doc.id}/state`);
        expect(state.status).toBe(200);
        expect(Buffer.from(await state.arrayBuffer()).includes(SECRET)).toBe(false);
        expect((await as(drive('file', fx.picture.id, 'preview'))).status).toBe(200);
        expect((await as(`/collab/${alice.id}/${mountId}/${fx.doc.id}/comments`)).status).toBe(200);
        expect((await childrenOf(charlie.sessionToken, fx.chatFolder.id)).map((child) => child.id)).toEqual([
            fx.thread.id,
        ]);
        const messages = await as(`/chat/${alice.id}/${mountId}/${fx.thread.id}/messages`);
        expect(messages.status).toBe(200);
        expect(JSON.stringify(await messages.json())).toContain('a reply');
        expect((await as(drive('file', fx.attachment.id, 'preview'))).status).toBe(200);
        expect((await as(drive('file', fx.doc.id, 'versions'))).status).toBe(200);
        const exported = await as(drive('file', fx.doc.id, 'export', 'html'));
        expect(exported.status).toBe(200);
        expect((await exported.text()).includes(SECRET)).toBe(false);
        expect((await as(drive('path', fx.doc.id, 'effective-members'))).status).toBe(200);
    }, 30_000);
});

describe('a live reader keeps the databases', () => {
    test('a reader by name lists, downloads and copies them', async () => {
        const names = (await childrenOf(bob.sessionToken, fx.doc.id)).map((child) => child.name);
        expect(names).toContain('data.db');
        for (const db of fx.databases) {
            expect((await authedRequest(bob.sessionToken, drive('file', db.id, 'download'))).status).toBe(200);
        }
        const home = await driveGet(bob.sessionToken, bob.id, await firstMountId(bob.sessionToken, bob.id), 'root');
        const copied = await authedRequest(bob.sessionToken, drive('path', fx.doc.id, 'copy'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetOwnerId: bob.id, targetMountId: home.mountId, targetParentId: home.id }),
        });
        expect(copied.status).toBe(200);
    }, 30_000);

    test('someone who may write it reads them, an ACL entry granting write alone included', async () => {
        const doc = await drivePost(alice.sessionToken, alice.id, mountId, `folder/${fx.folder.id}/create/doc`, {
            fileName: `Writable ${crypto.randomUUID()}`,
        });
        await drivePut(alice.sessionToken, alice.id, mountId, `path/${doc.id}/acl`, {
            add: [{ id: charlie.email, read: false, write: true }],
        });
        const dataDb = named(await childrenOf(charlie.sessionToken, doc.id), 'data.db');
        expect((await authedRequest(charlie.sessionToken, drive('file', dataDb.id, 'download'))).status).toBe(200);
    });

    test('the owner reads them', async () => {
        for (const db of fx.databases) {
            expect((await authedRequest(alice.sessionToken, drive('file', db.id, 'download'))).status).toBe(200);
        }
    });
});

// The rule itself, for the readers the routes above can't stand for, such as a member of the team that owns the drive.
describe('canReadFromAncestors on a raw database', () => {
    function chainOf(
        ownerId: string,
        visibility: DrivePath['visibility'],
        ...types: [DrivePathType, string][]
    ): DrivePath[] {
        let parentId: string | null = null;
        return [['folder', ''] as [DrivePathType, string], ...types].map(([type, name], i) => {
            const path: DrivePath = {
                id: `p${i}`,
                mountId: 'default',
                name,
                type,
                parentId,
                ownerId,
                mimeType: '',
                size: 0,
                hash: null,
                thumbnail: null,
                acl: null,
                visibility: i === 1 ? visibility : 'private',
                sharingRestricted: false,
                details: null,
                trashedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            parentId = path.id;
            return path;
        });
    }
    let reader: User;
    beforeAll(async () => {
        const found = await getUserByEmail(charlie.email);
        if (!found) throw new Error('No charlie');
        reader = found;
    });
    const none = { orgIds: [], teamIds: [] };
    const TEAM_ID = 'a'.repeat(32);

    test('names a database only as the direct file of a container', () => {
        expect(isRawDatabase(chainOf('o', 'link', ['doc', 'Notes.eigendoc'], ['file', 'data.db']))).toBe(true);
        expect(isRawDatabase(chainOf('o', 'link', ['doc', 'Notes.eigendoc'], ['file', 'comments.db']))).toBe(true);
        expect(
            isRawDatabase(chainOf('o', 'link', ['doc', 'N'], ['folder', 'chat'], ['chat', 't'], ['file', 'data.db'])),
        ).toBe(true);
        expect(isRawDatabase(chainOf('o', 'link', ['chat', 't'], ['file', 'comments.db']))).toBe(false);
        expect(isRawDatabase(chainOf('o', 'link', ['folder', 'f'], ['file', 'data.db']))).toBe(false);
        expect(isRawDatabase(chainOf('o', 'link', ['doc', 'N'], ['folder', 'media'], ['file', 'data.db']))).toBe(false);
        expect(isRawDatabase(chainOf('o', 'link', ['doc', 'N'], ['folder', 'versions'], ['file', 'v.db']))).toBe(true);
        expect(isRawDatabase(chainOf('o', 'link', ['folder', 'f'], ['folder', 'versions'], ['file', 'v.db']))).toBe(
            false,
        );
    });

    test('refuses a reader through a link or "Anyone signed in", and lets a team member, an editor and the owner read', () => {
        const db = (ownerId: string, visibility: DrivePath['visibility']) =>
            chainOf(ownerId, visibility, ['doc', 'N'], ['file', 'data.db']);
        expect(canReadFromAncestors(db('o', 'link'), reader, none, true)).toBe(false);
        expect(canReadFromAncestors(db('o', 'public-read'), reader, none, true)).toBe(false);
        expect(canReadFromAncestors(db('o', 'public-write'), reader, none, true)).toBe(true);
        expect(
            canReadFromAncestors(db(teamOwnerId(TEAM_ID), 'private'), reader, { orgIds: [], teamIds: [TEAM_ID] }, true),
        ).toBe(true);
        expect(canReadFromAncestors(db(reader.id, 'private'), reader, none, true)).toBe(true);
        expect(canReadFromAncestors(chainOf('o', 'link', ['doc', 'N'], ['folder', 'media']), reader, none, true)).toBe(
            true,
        );
    });
});
