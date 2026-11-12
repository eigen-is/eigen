import { afterAll, afterEach, beforeAll, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test';
import { shareTag } from '@workspace/lib/notification/tags';
import { parseOwnerId, teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as decoding from 'lib0/decoding';
import { CollabDocument } from '../../lib/collab/collab-document';
import { getPublicConfig } from '../../lib/config/server-config';
import { Drive } from '../../lib/drive';
import * as inlineEdit from '../../lib/drive/inline-edit';
import { MAX_INLINE_EDIT_SIZE } from '../../lib/drive/inline-edit';
import { touchRecent } from '../../lib/drive/recent';
import { getSharedDatabase } from '../../lib/drive/shared';
import { recentPaths } from '../../lib/drive/sharedschema';
import { clearHomeRestoring, getHome, markHomeRestoring } from '../../lib/home/get-home';
import type { TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    authedRequest,
    chatPost,
    createTeam,
    createTestGuest,
    createTestUser,
    driveDelete,
    driveGet,
    drivePost,
    drivePut,
    driveUpload,
    eventually,
    findOrFail,
    firstMountId,
    getTestContext,
} from '../setup';

// Opens are recorded after the response, so a test that expects no row first waits for a later open's row.

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let orgId: string;
let socketBase: string;

beforeAll(async () => {
    ctx = await getTestContext();
    orgId = getPublicConfig().orgId;
    await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId }),
    });
    socketBase = `ws://localhost:${ctx.app.listen(0).server?.port}/ws/collab`;
});

afterAll(() => {
    ctx.app.stop();
});

afterEach(() => {
    mock.restore();
    setSystemTime();
});

async function newViewer(): Promise<TestUser> {
    const user = await createTestUser(`recent-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Viewer');
    await getHome(user.id);
    return user;
}

async function rootOf(user: TestUser, ownerId = user.id): Promise<DrivePath> {
    const mountId = await firstMountId(user.sessionToken, ownerId);
    return driveGet(user.sessionToken, ownerId, mountId, 'root');
}

async function uploadText(user: TestUser, ownerId = user.id): Promise<DrivePath> {
    return upload(user, new File(['recent'], `${crypto.randomUUID()}.txt`, { type: 'text/plain' }), ownerId);
}

async function upload(user: TestUser, file: File, ownerId = user.id): Promise<DrivePath> {
    const root = await rootOf(user, ownerId);
    return driveUpload(user.sessionToken, ownerId, root.mountId, root.id, file);
}

async function create(user: TestUser, type: 'doc' | 'chat', parent?: DrivePath): Promise<DrivePath> {
    const folder = parent ?? (await rootOf(user));
    return drivePost(user.sessionToken, folder.ownerId, folder.mountId, `folder/${folder.id}/create/${type}`, {
        fileName: crypto.randomUUID(),
    });
}

async function childNamed(user: TestUser, container: DrivePath, name: string): Promise<DrivePath> {
    const children = await driveGet<DrivePath[]>(
        user.sessionToken,
        container.ownerId,
        container.mountId,
        `folder/${container.id}`,
    );
    return findOrFail(children, (child) => child.name === name);
}

function share(owner: TestUser, path: DrivePath, email: string, write = false): Promise<unknown> {
    return drivePut(owner.sessionToken, path.ownerId, path.mountId, `path/${path.id}/acl`, {
        add: [{ id: email, read: true, write }],
    });
}

async function openInEditor(user: TestUser, path: DrivePath, status = 200): Promise<void> {
    const res = await authedRequest(user.sessionToken, `/editor/${path.ownerId}/${path.mountId}/${path.id}/content`);
    expect(res.status).toBe(status);
}

async function openChat(user: TestUser, chat: DrivePath, query = '', status = 200): Promise<void> {
    const res = await authedRequest(
        user.sessionToken,
        `/chat/${chat.ownerId}/${chat.mountId}/${chat.id}/messages${query}`,
    );
    expect(res.status).toBe(status);
}

// Resolves once the server has answered the sync, which it sends right after the document took the socket.
function openSocket(user: TestUser, doc: DrivePath): Promise<void> {
    // The DOM typing of WebSocket hides Bun's options overload, as in the other collab socket tests.
    const ws = new WebSocket(`${socketBase}/${doc.ownerId}/${doc.mountId}/${doc.id}`, {
        headers: { cookie: `better-auth.session_token=${user.sessionToken}` },
    } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
        ws.onmessage = ({ data }) => {
            if (!(data instanceof ArrayBuffer)) return;
            const decoder = decoding.createDecoder(new Uint8Array(data));
            if (decoding.readVarUint(decoder) === 0 && decoding.readVarUint(decoder) === 0) {
                ws.close();
                resolve();
            }
        };
        ws.onclose = ({ code }) => reject(new Error(`socket closed with ${code}`));
        ws.onerror = () => reject(new Error('socket failed'));
    });
}

async function storedRows(user: TestUser) {
    const sharedDb = await getSharedDatabase(await getHome(user.id));
    return sharedDb.select().from(recentPaths).all();
}

async function storedIds(user: TestUser): Promise<string[]> {
    return (await storedRows(user)).map((row) => row.pathId);
}

function waitForRow(user: TestUser, path: DrivePath): Promise<true> {
    return eventually(async () => ((await storedIds(user)).includes(path.id) ? true : undefined), 'the row');
}

// Every open before this one has been written once this open's own row is there.
async function settle(user: TestUser): Promise<void> {
    const marker = await uploadText(user);
    await openInEditor(user, marker);
    await waitForRow(user, marker);
}

// A share's notification adds a row of its own, so a test of an open clears it first.
async function shareWithoutRow(owner: TestUser, path: DrivePath, user: TestUser): Promise<void> {
    await share(owner, path, user.email);
    await waitForRow(user, path);
    const sharedDb = await getSharedDatabase(await getHome(user.id));
    sharedDb.delete(recentPaths).run();
}

async function insertRow(user: TestUser, path: Pick<DrivePath, 'ownerId' | 'mountId' | 'id'>, secondsAgo: number) {
    const sharedDb = await getSharedDatabase(await getHome(user.id));
    sharedDb
        .insert(recentPaths)
        .values({
            ownerId: path.ownerId,
            mountId: path.mountId,
            pathId: path.id,
            lastActivityAt: new Date(Date.now() - secondsAgo * 1000),
        })
        .run();
}

function listRecent(user: TestUser): Promise<Response> {
    return authedRequest(user.sessionToken, `/drive/${user.id}/recent`);
}

async function listedIds(user: TestUser): Promise<string[]> {
    const res = await listRecent(user);
    expect(res.status).toBe(200);
    const paths: DrivePath[] = await res.json();
    return paths.map((path) => path.id);
}

async function newTeamOf(user: TestUser): Promise<string> {
    const teamId = await createTeam(ctx, orgId, `Recent ${crypto.randomUUID()}`);
    await addMember(ctx, teamId, user.id);
    await addTeamMount(ctx, teamId, 'Drive');
    return teamOwnerId(teamId);
}

describe('Recent records an open', () => {
    test('of a document over its socket', async () => {
        const viewer = await newViewer();
        const doc = await create(viewer, 'doc');
        await openSocket(viewer, doc);
        await waitForRow(viewer, doc);
        expect(await listedIds(viewer)).toContain(doc.id);
    });

    test('of a plain file in the inline editor', async () => {
        const viewer = await newViewer();
        const file = await uploadText(viewer);
        await openInEditor(viewer, file);
        await waitForRow(viewer, file);
        expect(await listedIds(viewer)).toContain(file.id);
    });

    test("of a chat's first page of messages, and not of an older page", async () => {
        const viewer = await newViewer();
        const chat = await create(viewer, 'chat');
        await openChat(viewer, chat, '?before=older');
        await settle(viewer);
        expect(await storedIds(viewer)).not.toContain(chat.id);

        await openChat(viewer, chat);
        await waitForRow(viewer, chat);
        expect(await listedIds(viewer)).toContain(chat.id);
    });

    test('and none of a chat whose messages fail to read', async () => {
        const viewer = await newViewer();
        const chat = await create(viewer, 'chat');
        spyOn(Drive.prototype, 'withDatabase').mockRejectedValue(new Error('data.db is unreadable'));
        spyOn(console, 'error').mockImplementation(() => {});
        await openChat(viewer, chat, '', 500);
        mock.restore();
        await settle(viewer);
        expect(await storedIds(viewer)).not.toContain(chat.id);
    });

    test('and none of a socket refused for no read access', async () => {
        const viewer = await newViewer();
        const doc = await create(ctx.alice.user, 'doc');
        await expect(openSocket(viewer, doc)).rejects.toThrow();
        await settle(viewer);
        expect(await storedIds(viewer)).not.toContain(doc.id);
    });

    test('and none of a socket whose read access is revoked while the document loads', async () => {
        const { alice } = ctx;
        const viewer = await newViewer();
        const doc = await create(alice.user, 'doc');
        await shareWithoutRow(alice.user, doc, viewer);
        // The share goes while the document loads. The socket's unsubscribe comes after its access check, whether the
        // check closed it or the test did.
        const open = CollabDocument.open;
        spyOn(CollabDocument, 'open').mockImplementationOnce(async (drive, path) => {
            await drivePut(alice.user.sessionToken, doc.ownerId, doc.mountId, `path/${doc.id}/acl`, {
                remove: [viewer.email],
            });
            return open(drive, path);
        });
        const checked = Promise.withResolvers<void>();
        const unsubscribe = CollabDocument.prototype.unsubscribe;
        spyOn(CollabDocument.prototype, 'unsubscribe').mockImplementationOnce(function (this: CollabDocument, conn) {
            unsubscribe.call(this, conn);
            checked.resolve();
        });
        await openSocket(viewer, doc).catch(() => undefined);
        await checked.promise;
        await settle(viewer);
        expect(await storedIds(viewer)).not.toContain(doc.id);
    });

    test("and none of a trashed document's socket", async () => {
        const viewer = await newViewer();
        const doc = await create(viewer, 'doc');
        await driveDelete(viewer.sessionToken, viewer.id, doc.mountId, `path/${doc.id}`);
        await expect(openSocket(viewer, doc)).rejects.toThrow();
        await settle(viewer);
        expect(await storedIds(viewer)).not.toContain(doc.id);
    });

    test('and none of a binary file the inline editor refuses', async () => {
        const viewer = await newViewer();
        const file = await upload(viewer, new File([new Uint8Array([0, 1, 2])], `${crypto.randomUUID()}.bin`));
        await openInEditor(viewer, file, 400);
        await settle(viewer);
        expect(await storedIds(viewer)).not.toContain(file.id);
    });

    test('and none of a file too large for the inline editor', async () => {
        const viewer = await newViewer();
        const name = `${crypto.randomUUID()}.txt`;
        const file = await upload(
            viewer,
            new File(['x'.repeat(MAX_INLINE_EDIT_SIZE + 1)], name, { type: 'text/plain' }),
        );
        await openInEditor(viewer, file, 413);
        await settle(viewer);
        expect(await storedIds(viewer)).not.toContain(file.id);
    });

    test('and an editor read is served when the document check fails', async () => {
        const viewer = await newViewer();
        const file = await uploadText(viewer);
        const getEditableContent = inlineEdit.getEditableContent;
        spyOn(inlineEdit, 'getEditableContent').mockImplementation(async (mount, path) => {
            const content = await getEditableContent(mount, path);
            spyOn(mount, 'getBreadcrumb').mockRejectedValue(new Error('metadata.db is busy'));
            return content;
        });
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        await openInEditor(viewer, file);
        await eventually(async () => (errors.mock.calls.length > 0 ? true : undefined), 'the logged failure');
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('recent:'), expect.anything());
        expect(await storedIds(viewer)).not.toContain(file.id);
    });

    test("and none of a comment thread's messages", async () => {
        const viewer = await newViewer();
        const doc = await create(viewer, 'doc');
        const thread = await create(viewer, 'chat', await childNamed(viewer, doc, 'chat'));
        await openChat(viewer, thread);
        await settle(viewer);
        expect(await storedIds(viewer)).not.toContain(thread.id);
    });

    test('and none of a file inside a document, in the inline editor', async () => {
        const viewer = await newViewer();
        const media = await childNamed(viewer, await create(viewer, 'doc'), 'media');
        const file = new File(['inside'], `${crypto.randomUUID()}.txt`, { type: 'text/plain' });
        const inside = await driveUpload(viewer.sessionToken, viewer.id, media.mountId, media.id, file);
        await openInEditor(viewer, inside);
        await settle(viewer);
        expect(await storedIds(viewer)).not.toContain(inside.id);
    });

    test('and none of a preview', async () => {
        const viewer = await newViewer();
        const file = await uploadText(viewer);
        const res = await authedRequest(
            viewer.sessionToken,
            `/drive/${viewer.id}/${file.mountId}/file/${file.id}/text-preview`,
        );
        expect(res.status).toBe(200);
        await settle(viewer);
        expect(await storedIds(viewer)).not.toContain(file.id);
    });

    test('and a failing write does not fail the open', async () => {
        const viewer = await newViewer();
        const file = await uploadText(viewer);
        spyOn(Drive.prototype, 'touchRecent').mockImplementation(() => {
            throw new Error('shared.db is full');
        });
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        await openInEditor(viewer, file);
        await eventually(async () => (errors.mock.calls.length > 0 ? true : undefined), 'the logged failure');
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('recent:'), expect.anything());
        expect(await storedIds(viewer)).not.toContain(file.id);
    });

    test('in one row however often the file opens, at the time of the last open', async () => {
        const viewer = await newViewer();
        const file = await uploadText(viewer);
        await insertRow(viewer, file, 3600);
        for (let i = 0; i < 3; i++) await openInEditor(viewer, file);
        await settle(viewer);
        const rows = (await storedRows(viewer)).filter((row) => row.pathId === file.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].lastActivityAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    test('and keeps the newest 200 rows, dropping the oldest in the same write', async () => {
        const viewer = await newViewer();
        const root = await rootOf(viewer);
        const fakes = Array.from({ length: 200 }, () => ({
            ownerId: viewer.id,
            mountId: root.mountId,
            id: crypto.randomUUID(),
        }));
        for (const [i, fake] of fakes.entries()) await insertRow(viewer, fake, 1000 + i);
        const file = await uploadText(viewer);
        await openInEditor(viewer, file);
        await waitForRow(viewer, file);
        const ids = await storedIds(viewer);
        expect(ids).toHaveLength(200);
        expect(ids).not.toContain(fakes[199].id);
        expect(ids).toContain(fakes[198].id);
    });

    test('and keeps the row just written when the 200 kept rows share its second', async () => {
        const viewer = await newViewer();
        const root = await rootOf(viewer);
        setSystemTime(new Date());
        for (let i = 0; i < 200; i++) await insertRow(viewer, { ...root, id: crypto.randomUUID() }, 0);
        const sharedDb = await getSharedDatabase(await getHome(viewer.id));
        touchRecent(sharedDb, viewer.id, root.mountId, 'written-last');
        const ids = await storedIds(viewer);
        expect(ids).toHaveLength(200);
        expect(ids).toContain('written-last');
    });

    test("and records nothing for a guest's open", async () => {
        const { alice } = ctx;
        const guest = await createTestGuest('Recent Guest');
        await getHome(guest.id);
        const file = await uploadText(alice.user);
        await shareWithoutRow(alice.user, file, guest);
        await openInEditor(guest, file);
        await settle(await newViewer());
        expect(await storedRows(guest)).toEqual([]);
    });
});

describe('Recent records a notification', () => {
    async function notificationTagged(user: TestUser, tag: string) {
        const home = await getHome(user.id);
        return eventually(
            async () => home.notifications.list().find((notification) => notification.tag === tag),
            `the notification ${tag}`,
        );
    }

    test('about a share', async () => {
        const viewer = await newViewer();
        const file = await uploadText(ctx.alice.user);
        await share(ctx.alice.user, file, viewer.email);
        await waitForRow(viewer, file);
        expect(await listedIds(viewer)).toContain(file.id);
    });

    test('and keeps the row once the notification is dismissed', async () => {
        const viewer = await newViewer();
        const file = await uploadText(ctx.alice.user);
        await share(ctx.alice.user, file, viewer.email);
        await waitForRow(viewer, file);
        const notification = await notificationTagged(
            viewer,
            shareTag({ ownerId: file.ownerId, mountId: file.mountId, pathId: file.id }),
        );
        const res = await authedRequest(viewer.sessionToken, `/notifications/${viewer.id}/${notification.id}`, {
            method: 'DELETE',
        });
        expect(res.status).toBe(200);
        expect(await listedIds(viewer)).toContain(file.id);
    });

    test('and adds no row for a type that names no file', async () => {
        const viewer = await newViewer();
        const home = await getHome(viewer.id);
        home.notify({ type: 'mail', title: 'New mail', tag: 'mail:new' });
        home.notify({ type: 'calendar-invite', title: 'Invite', tag: `calendar-invite:${crypto.randomUUID()}:0` });
        home.notify({ type: 'admin-alert', title: 'Backup failed', tag: `backup-verify-${viewer.id}` });
        home.notify({ type: 'unshare', title: 'Access removed' });
        expect(home.notifications.list()).toHaveLength(4);
        expect(await storedRows(viewer)).toEqual([]);
    });

    test('and a failing write does not fail the notification', async () => {
        const viewer = await newViewer();
        const file = await uploadText(ctx.alice.user);
        spyOn(Drive.prototype, 'touchRecent').mockImplementation(() => {
            throw new Error('shared.db is full');
        });
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        await share(ctx.alice.user, file, viewer.email);
        await notificationTagged(viewer, shareTag({ ownerId: file.ownerId, mountId: file.mountId, pathId: file.id }));
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('recent:'), expect.anything());
        expect(await storedIds(viewer)).not.toContain(file.id);
    });

    test('about a comment, naming its document and not the thread', async () => {
        const { alice } = ctx;
        const viewer = await newViewer();
        const doc = await create(viewer, 'doc');
        const thread = await create(viewer, 'chat', await childNamed(viewer, doc, 'chat'));
        await share(viewer, doc, alice.user.email, true);
        await chatPost(alice.user.sessionToken, viewer.id, thread.mountId, `${thread.id}/messages`, {
            content: 'A comment',
        });
        await waitForRow(viewer, doc);
        expect(await storedIds(viewer)).not.toContain(thread.id);
    });

    test('about a chat message, naming the chat', async () => {
        const { alice } = ctx;
        const viewer = await newViewer();
        const chat = await create(viewer, 'chat');
        await share(viewer, chat, alice.user.email, true);
        await chatPost(alice.user.sessionToken, viewer.id, chat.mountId, `${chat.id}/messages`, {
            content: 'A message',
        });
        await waitForRow(viewer, chat);
        expect(await listedIds(viewer)).toContain(chat.id);
    });

    test('about a watched change, naming the file, or the folder of an upload', async () => {
        const { alice } = ctx;
        const viewer = await newViewer();
        const root = await rootOf(viewer);
        const folder = await drivePost<DrivePath>(viewer.sessionToken, viewer.id, root.mountId, `folder/${root.id}`, {
            folderName: crypto.randomUUID(),
        });
        await share(viewer, folder, alice.user.email, true);
        const watched = await authedRequest(
            viewer.sessionToken,
            `/drive/${viewer.id}/${folder.mountId}/path/${folder.id}/watch`,
            { method: 'POST' },
        );
        expect(watched.status).toBe(200);

        const file = new File(['watched'], `${crypto.randomUUID()}.txt`, { type: 'text/plain' });
        const uploaded = await driveUpload(alice.user.sessionToken, viewer.id, folder.mountId, folder.id, file);
        await waitForRow(viewer, folder);
        expect(await storedIds(viewer)).not.toContain(uploaded.id);

        await drivePut(alice.user.sessionToken, viewer.id, folder.mountId, `path/${uploaded.id}/rename`, {
            newName: `${crypto.randomUUID()}.txt`,
        });
        await waitForRow(viewer, uploaded);
    });
});

describe('Recent lists', () => {
    test('a shared, a team and a public file', async () => {
        const { alice } = ctx;
        const viewer = await newViewer();
        const shared = await uploadText(alice.user);
        await share(alice.user, shared, viewer.email);
        const team = await newTeamOf(viewer);
        const teamFile = await uploadText(viewer, team);
        const publicFile = await uploadText(alice.user);
        await drivePut(alice.user.sessionToken, alice.user.id, publicFile.mountId, `path/${publicFile.id}/acl`, {
            visibility: 'public-read',
        });
        for (const path of [shared, teamFile, publicFile]) await openInEditor(viewer, path);
        await settle(viewer);
        expect(await listedIds(viewer)).toEqual(expect.arrayContaining([shared.id, teamFile.id, publicFile.id]));
    });

    test('a revoked share hidden, and back once it is shared again', async () => {
        const { alice } = ctx;
        const viewer = await newViewer();
        const file = await uploadText(alice.user);
        await share(alice.user, file, viewer.email);
        await openInEditor(viewer, file);
        await waitForRow(viewer, file);
        expect(await listedIds(viewer)).toContain(file.id);

        await drivePut(alice.user.sessionToken, alice.user.id, file.mountId, `path/${file.id}/acl`, {
            remove: [viewer.email],
        });
        expect(await listedIds(viewer)).not.toContain(file.id);
        expect(await storedIds(viewer)).toContain(file.id);

        await share(alice.user, file, viewer.email);
        expect(await listedIds(viewer)).toContain(file.id);
    });

    test('no team file once the user is removed from the team', async () => {
        const viewer = await newViewer();
        const team = await newTeamOf(viewer);
        const teamFile = await uploadText(viewer, team);
        await openInEditor(viewer, teamFile);
        await waitForRow(viewer, teamFile);
        expect(await listedIds(viewer)).toContain(teamFile.id);

        const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/remove-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: parseOwnerId(team).id, userId: viewer.id }),
        });
        expect(res.status).toBe(200);
        expect(await listedIds(viewer)).not.toContain(teamFile.id);
    });

    test('a trashed file hidden, and back once it is restored', async () => {
        const viewer = await newViewer();
        const file = await uploadText(viewer);
        await openInEditor(viewer, file);
        await waitForRow(viewer, file);

        await driveDelete(viewer.sessionToken, viewer.id, file.mountId, `path/${file.id}`);
        expect(await listedIds(viewer)).not.toContain(file.id);

        const res = await authedRequest(
            viewer.sessionToken,
            `/drive/${viewer.id}/${file.mountId}/trash/${file.id}/restore`,
            {
                method: 'POST',
            },
        );
        expect(res.status).toBe(200);
        expect(await listedIds(viewer)).toContain(file.id);
    });

    test('no deleted file, and keeps its row', async () => {
        const viewer = await newViewer();
        const file = await uploadText(viewer);
        await openInEditor(viewer, file);
        await waitForRow(viewer, file);

        await driveDelete(viewer.sessionToken, viewer.id, file.mountId, `path/${file.id}`);
        await driveDelete(viewer.sessionToken, viewer.id, file.mountId, `trash/${file.id}`);
        expect(await listedIds(viewer)).not.toContain(file.id);
        expect(await storedIds(viewer)).toContain(file.id);
    });

    test('no mount root', async () => {
        const viewer = await newViewer();
        const root = await rootOf(viewer);
        await insertRow(viewer, root, 0);
        expect(await listedIds(viewer)).not.toContain(root.id);
    });

    test('a document and a chat, and nothing inside a document', async () => {
        const viewer = await newViewer();
        const doc = await create(viewer, 'doc');
        const chat = await create(viewer, 'chat');
        const thread = await create(viewer, 'chat', await childNamed(viewer, doc, 'chat'));
        const media = await childNamed(viewer, doc, 'media');
        const dataDb = await childNamed(viewer, chat, 'data.db');
        for (const path of [doc, chat, thread, media, dataDb]) await insertRow(viewer, path, 10);

        const ids = await listedIds(viewer);
        expect(ids).toEqual(expect.arrayContaining([doc.id, chat.id]));
        for (const inside of [thread, media, dataDb]) expect(ids).not.toContain(inside.id);
    });

    test('no file the user cannot read', async () => {
        const viewer = await newViewer();
        const file = await uploadText(ctx.alice.user);
        await insertRow(viewer, file, 10);
        expect(await listedIds(viewer)).not.toContain(file.id);
    });

    test("the owner's other rows when one row names a mount the owner lacks", async () => {
        const viewer = await newViewer();
        const file = await uploadText(viewer);
        await insertRow(viewer, file, 20);
        await insertRow(viewer, { ownerId: viewer.id, mountId: 'gone', id: crypto.randomUUID() }, 10);
        expect(await listedIds(viewer)).toEqual([file.id]);
    });

    test('the other owners when one fails, which keeps its rows', async () => {
        const viewer = await newViewer();
        const own = await uploadText(viewer);
        const team = await newTeamOf(viewer);
        const teamFile = await uploadText(viewer, team);
        await insertRow(viewer, own, 20);
        await insertRow(viewer, teamFile, 10);

        const errors = spyOn(console, 'error').mockImplementation(() => {});
        markHomeRestoring(team);
        let ids: string[];
        try {
            ids = await listedIds(viewer);
        } finally {
            clearHomeRestoring(team);
        }
        expect(errors).toHaveBeenCalledWith(expect.stringContaining(team), expect.anything());
        expect(ids).toEqual([own.id]);
        expect(await storedIds(viewer)).toContain(teamFile.id);
        expect(await listedIds(viewer)).toEqual([teamFile.id, own.id]);
    });

    test('nothing of a deleted owner, with no error logged', async () => {
        const viewer = await newViewer();
        const owner = await newViewer();
        const file = await uploadText(owner);
        await share(owner, file, viewer.email);
        await openInEditor(viewer, file);
        await waitForRow(viewer, file);
        const deleted = await authedRequest(ctx.alice.user.sessionToken, `/settings/user/${owner.id}`, {
            method: 'DELETE',
        });
        expect(deleted.status).toBe(200);

        const errors = spyOn(console, 'error').mockImplementation(() => {});
        expect(await listedIds(viewer)).not.toContain(file.id);
        expect(errors.mock.calls.some((call) => call.some((arg) => String(arg).includes(owner.id)))).toBe(false);
        expect(await storedIds(viewer)).toContain(file.id);
    });

    test('newest first, asking only the newest 100 rows when they are all visible', async () => {
        const viewer = await newViewer();
        const root = await rootOf(viewer);
        const older = await uploadText(viewer);
        await insertRow(viewer, older, 5000);
        const folders: DrivePath[] = [];
        for (let i = 0; i < 100; i++) {
            const folder = await drivePost(viewer.sessionToken, viewer.id, root.mountId, `folder/${root.id}`, {
                folderName: `f${i}`,
            });
            await insertRow(viewer, folder, 1000 - i);
            folders.push(folder);
        }

        const asked = spyOn(Drive.prototype, 'getVisiblePaths');
        const ids = await listedIds(viewer);
        expect(ids).toEqual(folders.map((folder) => folder.id).reverse());
        const askedIds = asked.mock.calls.flatMap(([, , rows]) => rows.map((row) => row.pathId));
        expect(askedIds).not.toContain(older.id);
    });

    test('older rows when too few of the newest 100 are visible', async () => {
        const viewer = await newViewer();
        const root = await rootOf(viewer);
        const older = await uploadText(viewer);
        await insertRow(viewer, older, 5000);
        for (let i = 0; i < 100; i++) {
            await insertRow(viewer, { ownerId: viewer.id, mountId: root.mountId, id: crypto.randomUUID() }, 1000 - i);
        }
        expect(await listedIds(viewer)).toEqual([older.id]);
    });
});

describe('Recent refuses', () => {
    test('a guest', async () => {
        const guest = await createTestGuest('Recent Route Guest');
        expect((await listRecent(guest)).status).toBe(403);
    });

    test("another user's list", async () => {
        const viewer = await newViewer();
        const res = await authedRequest(viewer.sessionToken, `/drive/${ctx.alice.user.id}/recent`);
        expect(res.status).toBe(403);
    });
});
