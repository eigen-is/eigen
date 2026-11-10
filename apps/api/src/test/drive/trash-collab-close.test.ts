import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { ChatMessage, DrivePath } from '@workspace/lib/types';
import { ApiError } from '../../lib/core/errors';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { TestUser } from '../setup';
import {
    assertJson,
    authedRequest,
    chatPost,
    createTestUserOnStorage,
    driveGet,
    drivePost,
    getTestContext,
} from '../setup';

const mountId = 'default';

// A trash marks the item first and then closes what is open under it. Every sync resolves its key from
// the row, so whatever an open document or database writes until the close lands with the trashed item.
for (const storage of ['local-id', 'local-fullnames'] as const) {
    describe(`a trash closes what is open under the item (${storage})`, () => {
        let user: TestUser;
        let home: Home;
        let rootId: string;

        beforeAll(async () => {
            const ctx = await getTestContext();
            user = storage === 'local-id' ? ctx.alice.user : await createTestUserOnStorage(storage, 'Trash Close');
            home = await getHome(user.id);
            rootId = (await driveGet<DrivePath>(user.sessionToken, user.id, mountId, 'root')).id;
        });

        const createIn = (folderId: string, kind: 'doc' | 'chat', fileName: string) =>
            drivePost<DrivePath>(user.sessionToken, user.id, mountId, `folder/${folderId}/create/${kind}`, {
                fileName,
            });

        // Runs the DELETE and returns what it logged as an error.
        const trashLogging = async (pathId: string): Promise<unknown[][]> => {
            const errors = spyOn(console, 'error');
            try {
                await home.drive.deletePath(mountId, pathId, home.user);
                return errors.mock.calls;
            } finally {
                errors.mockRestore();
            }
        };

        test('DELETE on an open document closes it, and logs nothing', async () => {
            const doc = await createIn(rootId, 'doc', 'trash-close');
            const collab = await home.drive.getCollabDocument(mountId, doc.id);
            collab.doc.getMap('state').set('marker', 'edited');

            const res = await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/path/${doc.id}`, {
                method: 'DELETE',
            });
            expect(res.status).toBe(200);
            expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);
        });

        // A socket that connects to the open document after the mark joins it and is closed with it. One that
        // opens a closed document after the mark gets a 404.
        test('an edit made while the trash runs survives a restore, and an open after the mark is a 404', async () => {
            const folder = await home.drive.createFolder(mountId, rootId, 'trash-window', home.user);
            const doc = await createIn(folder.id, 'doc', 'trash-window-doc');
            const closedDoc = await createIn(folder.id, 'doc', 'trash-window-closed');
            const collab = await home.drive.getCollabDocument(mountId, doc.id);
            collab.doc.getMap('state').set('before', 'kept');
            const { mount } = await home.drive.resolveFile(mountId, doc.id);
            const trashPath = mount.trashPath.bind(mount);
            const getActivePath = mount.getActivePath.bind(mount);
            let joined: unknown = null;
            let lateOpen: Promise<unknown> = Promise.resolve();
            const spy = spyOn(mount, 'trashPath').mockImplementationOnce(async (pathId) => {
                const trashed = await trashPath(pathId);
                joined = await home.drive.getCollabDocument(mountId, doc.id);
                collab.doc.getMap('state').set('during', 'typed');
                // The open reads its row only once the trash's close waits for it.
                activeSpy.mockImplementationOnce(async (id) => {
                    await Bun.sleep(50);
                    return getActivePath(id);
                });
                lateOpen = home.drive.getCollabDocument(mountId, closedDoc.id).catch((e: unknown) => e);
                return trashed;
            });
            const activeSpy = spyOn(mount, 'getActivePath');
            let logged: unknown[][];
            try {
                logged = await trashLogging(folder.id);
            } finally {
                spy.mockRestore();
                activeSpy.mockRestore();
            }

            expect(joined).toBe(collab);
            const opened = await lateOpen;
            expect(opened instanceof ApiError && opened.status).toBe(404);
            expect(logged).toEqual([]);
            expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);
            expect(home.drive.hasCollabDocument(mountId, closedDoc.id)).toBe(false);

            await home.drive.restorePath(mountId, folder.id, home.user);
            const restored = await home.drive.getCollabDocument(mountId, doc.id);
            expect(restored.doc.getMap('state').toJSON()).toEqual({ before: 'kept', during: 'typed' });
            await home.drive.closeCollabDocument(mountId, doc.id);
        });

        // A chat's data.db is no collab document, and stays open after a post.
        test("a chat's open data.db under a trashed folder is closed by the trash, and its post survives a restore", async () => {
            const folder = await home.drive.createFolder(mountId, rootId, 'trash-chat', home.user);
            const chat = await createIn(folder.id, 'chat', 'trash-chat-room');
            await chatPost(user.sessionToken, user.id, mountId, `${chat.id}/messages`, { content: 'keep me' });
            const { mount } = await home.drive.resolveFile(mountId, chat.id);
            const dataDb = await mount.getChildByName(chat.id, 'data.db');
            expect(dataDb && mount.documentDbs.has(dataDb.id)).toBe(true);

            expect(await trashLogging(folder.id)).toEqual([]);
            expect(dataDb && mount.documentDbs.has(dataDb.id)).toBe(false);

            await home.drive.restorePath(mountId, folder.id, home.user);
            const res = await authedRequest(user.sessionToken, `/chat/${user.id}/${mountId}/${chat.id}/messages`);
            const messages = await assertJson<ChatMessage[]>(res);
            expect(messages.map((m) => m.content)).toContain('keep me');
        });

        // A restore that runs before the trash marks the folder lands in it, and its document goes to
        // the trash with the folder.
        test('a document restored into the folder while it is trashed is closed, and its edits persist', async () => {
            const folder = await home.drive.createFolder(mountId, rootId, 'trash-restore-in', home.user);
            const doc = await createIn(folder.id, 'doc', 'trash-restore-in-doc');
            await home.drive.deletePath(mountId, doc.id, home.user);
            const { mount } = await home.drive.resolveFile(mountId, folder.id);
            const trashPath = mount.trashPath.bind(mount);
            const spy = spyOn(mount, 'trashPath').mockImplementationOnce(async (pathId) => {
                await home.drive.restorePath(mountId, doc.id, home.user);
                const collab = await home.drive.getCollabDocument(mountId, doc.id);
                collab.doc.getMap('state').set('before', 'kept');
                return trashPath(pathId);
            });
            try {
                expect(await trashLogging(folder.id)).toEqual([]);
            } finally {
                spy.mockRestore();
            }
            expect((await mount.getPath(doc.id))?.trashedAt).not.toBeNull();
            expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);

            await home.drive.restorePath(mountId, folder.id, home.user);
            const reopened = await home.drive.getCollabDocument(mountId, doc.id);
            expect(reopened.doc.getMap('state').toJSON()).toEqual({ before: 'kept' });
            await home.drive.closeCollabDocument(mountId, doc.id);
        });

        // The inner trash fails before it closes anything, and the folder's trash closes the document.
        test('a failed trash of a document inside a folder that is being trashed leaves its close to the folder', async () => {
            const folder = await home.drive.createFolder(mountId, rootId, 'trash-nested', home.user);
            const doc = await createIn(folder.id, 'doc', 'trash-nested-doc');
            const collab = await home.drive.getCollabDocument(mountId, doc.id);
            const { mount } = await home.drive.resolveFile(mountId, doc.id);
            const trashPath = mount.trashPath.bind(mount);
            let innerTrash: unknown = null;
            const spy = spyOn(mount, 'trashPath')
                .mockImplementationOnce(async (pathId) => {
                    innerTrash = await home.drive.deletePath(mountId, doc.id, home.user).catch((e: unknown) => e);
                    collab.doc.getMap('state').set('during', 'typed');
                    return trashPath(pathId);
                })
                .mockImplementationOnce(async () => {
                    throw new ApiError(503, 'storage unavailable');
                });
            try {
                await home.drive.deletePath(mountId, folder.id, home.user);
            } finally {
                spy.mockRestore();
            }

            expect(innerTrash instanceof ApiError && innerTrash.status).toBe(503);
            expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);
            const lateOpen = await home.drive.getCollabDocument(mountId, doc.id).catch((e: unknown) => e);
            expect(lateOpen instanceof ApiError && lateOpen.status).toBe(404);

            await home.drive.restorePath(mountId, folder.id, home.user);
            const restored = await home.drive.getCollabDocument(mountId, doc.id);
            expect(restored.doc.getMap('state').toJSON()).toEqual({ during: 'typed' });
            await home.drive.closeCollabDocument(mountId, doc.id);
        });

        // The trash is in once trashPath returns. A close that fails only logs, the walk goes on to the
        // document's data.db, and the DELETE still succeeds.
        test('a close that fails after the trash still answers the DELETE with success', async () => {
            const doc = await createIn(rootId, 'doc', 'trash-close-fails');
            await home.drive.getCollabDocument(mountId, doc.id);
            const { mount } = await home.drive.resolveFile(mountId, doc.id);
            const dataDb = await mount.getChildByName(doc.id, 'data.db');
            const closeSpy = spyOn(mount, 'closeDatabase').mockImplementationOnce(async () => {
                throw new ApiError(503, 'storage unavailable');
            });
            const errors = spyOn(console, 'error').mockImplementation(() => {});
            let res: Response;
            let logged: unknown[][];
            try {
                res = await authedRequest(user.sessionToken, `/drive/${user.id}/${mountId}/path/${doc.id}`, {
                    method: 'DELETE',
                });
            } finally {
                logged = errors.mock.calls;
                errors.mockRestore();
                closeSpy.mockRestore();
            }
            expect(res.status).toBe(200);
            expect((await mount.getPath(doc.id))?.trashedAt).not.toBeNull();
            expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);
            expect(logged.some((call) => String(call[0]).includes(doc.id))).toBe(true);
            expect(dataDb && mount.documentDbs.has(dataDb.id)).toBe(false);
        });
    });
}
