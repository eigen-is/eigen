import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CollabDocument } from '../../lib/collab/collab-document';
import { ApiError } from '../../lib/core/errors';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { HOLDER_WAIT_MS } from '../../lib/mount/document-db';
import { authedRequest, driveGet, drivePost, getTestContext } from '../setup';

// Trashing an open eigendoc tears the collab document down, so no live session keeps editing a
// trashed document and no open database syncs its data.db to the pre-trash key.
describe('trash closes open collab documents', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let home: Home;
    let rootId: string;
    const mountId = 'default';

    beforeAll(async () => {
        ctx = await getTestContext();
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        home = await getHome(ctx.alice.user.id);
    });

    const createDoc = (fileName: string) =>
        drivePost<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `folder/${rootId}/create/doc`, {
            fileName,
        });

    test('DELETE on an open .eigendoc closes it', async () => {
        const doc = await createDoc('trash-close');
        await home.drive.getCollabDocument(mountId, doc.id);
        expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(true);

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/path/${doc.id}`,
            { method: 'DELETE' },
        );
        expect(res.status).toBe(200);
        expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);
    });

    // trashPath closes the document's database, which a collab doc still open would then persist into.
    test('an open .eigendoc is closed before its database, so its last state persists cleanly', async () => {
        const doc = await createDoc('trash-clean');
        const collab = await home.drive.getCollabDocument(mountId, doc.id);
        collab.doc.getMap('state').set('marker', 'edited');
        const errors = spyOn(console, 'error');
        let logged: unknown[][];
        try {
            await home.drive.deletePath(mountId, doc.id);
        } finally {
            logged = errors.mock.calls;
            errors.mockRestore();
        }
        expect(logged).toEqual([]);
    });

    // The path stays active until trashPath writes trashedAt, and trashPath closes the databases first.
    // A document opened in between would save its edits into a closed data.db, so the open is refused.
    test('an open while the trash runs is refused, and every edit made before it is there after a restore', async () => {
        const doc = await createDoc('trash-window');
        const collab = await home.drive.getCollabDocument(mountId, doc.id);
        collab.doc.getMap('state').set('before', 'kept');
        const { mount } = await home.drive.resolveFile(mountId, doc.id);
        const trashPath = mount.trashPath.bind(mount);
        const withTreeExclusive = mount.withTreeExclusive.bind(mount);
        let lateOpen: unknown = null;
        const trashSpy = spyOn(mount, 'trashPath').mockImplementationOnce(async (pathId) => {
            lateOpen = await home.drive.getCollabDocument(mountId, doc.id).catch((e: unknown) => e);
            return trashPath(pathId);
        });
        // trashPath takes the tree lock right after it closed the databases under the item.
        const lockSpy = spyOn(mount, 'withTreeExclusive').mockImplementationOnce(async (work) => {
            if (lateOpen instanceof CollabDocument) lateOpen.doc.getMap('state').set('during', 'edited');
            return withTreeExclusive(work);
        });
        const errors = spyOn(console, 'error');
        let logged: unknown[][];
        try {
            await home.drive.deletePath(mountId, doc.id);
        } finally {
            logged = errors.mock.calls;
            errors.mockRestore();
            trashSpy.mockRestore();
            lockSpy.mockRestore();
        }

        expect(lateOpen).toBeInstanceOf(ApiError);
        expect(lateOpen instanceof ApiError && lateOpen.status).toBe(503);
        expect(logged.some((call) => call.some((part) => String(part).includes('closed database')))).toBe(false);
        expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);

        await home.drive.restorePath(mountId, doc.id);
        const restored = await home.drive.getCollabDocument(mountId, doc.id);
        expect(restored.doc.getMap('state').get('before')).toBe('kept');
    });

    // A move checks its target folder, then waits to write, here until the trash of that folder has
    // closed the collab documents in it. The move is refused, so the trash never meets an open
    // document that moved in after its collab close, and it doesn't wait HOLDER_WAIT_MS for one.
    test('a move into a folder while the folder is trashed is refused, and the document stays open', async () => {
        const folder = await home.drive.createFolder(mountId, rootId, 'trash-move-in');
        const doc = await createDoc('trash-move-in-doc');
        const collab = await home.drive.getCollabDocument(mountId, doc.id);
        collab.doc.getMap('state').set('before', 'kept');
        const { mount } = await home.drive.resolveFile(mountId, doc.id);
        const updatePath = mount.updatePath.bind(mount);
        const trashPath = mount.trashPath.bind(mount);
        const moveWaits = Promise.withResolvers<void>();
        const collabClosed = Promise.withResolvers<void>();
        let move: Promise<unknown> = Promise.resolve();
        const moveSpy = spyOn(mount, 'updatePath').mockImplementationOnce(async (...args) => {
            moveWaits.resolve();
            await collabClosed.promise;
            return updatePath(...args);
        });
        // trashPath runs after the collab close and closes the databases under the folder first.
        const trashSpy = spyOn(mount, 'trashPath').mockImplementationOnce(async (pathId) => {
            collabClosed.resolve();
            await move;
            return trashPath(pathId);
        });
        const started = Date.now();
        try {
            move = home.drive.movePath(mountId, doc.id, folder.id).catch((e: unknown) => e);
            await moveWaits.promise;
            await home.drive.deletePath(mountId, folder.id);
        } finally {
            moveSpy.mockRestore();
            trashSpy.mockRestore();
        }
        const moved = await move;

        expect(moved instanceof ApiError && moved.status).toBe(404);
        expect(Date.now() - started).toBeLessThan(HOLDER_WAIT_MS);
        expect((await mount.getPath(doc.id))?.parentId).toBe(rootId);
        expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(true);
        collab.doc.getMap('state').set('after', 'typed');
        await home.drive.closeCollabDocument(mountId, doc.id);
        const fresh = await home.drive.getCollabDocument(mountId, doc.id);
        expect(fresh.doc.getMap('state').toJSON()).toEqual({ before: 'kept', after: 'typed' });
    });

    // A restore can still put a document in the folder after the trash began, and the document can then
    // be opened. trashPath takes the tree lock right after it closed the databases under the folder, so
    // the document opens there, and the trash closes it after trashPath returns.
    const restoreIntoTrashedFolder = async (name: string) => {
        const folder = await home.drive.createFolder(mountId, rootId, name);
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${folder.id}/create/doc`,
            { fileName: `${name}-doc` },
        );
        await home.drive.deletePath(mountId, doc.id);
        const { mount } = await home.drive.resolveFile(mountId, folder.id);
        const withTreeExclusive = mount.withTreeExclusive.bind(mount);
        const lockSpy = spyOn(mount, 'withTreeExclusive').mockImplementationOnce(async (work) => {
            await home.drive.restorePath(mountId, doc.id);
            const collab = await home.drive.getCollabDocument(mountId, doc.id);
            collab.doc.getMap('state').set('before', 'kept');
            return withTreeExclusive(work);
        });
        return { folder, doc, mount, lockSpy };
    };

    test('a document restored into the folder while it is trashed is closed, and edits after the restore persist', async () => {
        const { folder, doc, mount, lockSpy } = await restoreIntoTrashedFolder('trash-restore-in');
        try {
            await home.drive.deletePath(mountId, folder.id);
        } finally {
            lockSpy.mockRestore();
        }
        expect((await mount.getPath(doc.id))?.trashedAt).not.toBeNull();
        expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);

        await home.drive.restorePath(mountId, folder.id);
        const reopened = await home.drive.getCollabDocument(mountId, doc.id);
        reopened.doc.getMap('state').set('afterRestore', 'typed');
        await home.drive.closeCollabDocument(mountId, doc.id);
        const fresh = await home.drive.getCollabDocument(mountId, doc.id);
        expect(fresh.doc.getMap('state').toJSON()).toEqual({ before: 'kept', afterRestore: 'typed' });
    });

    // The trash is in once trashPath returns. A document that arrived and then fails to close only
    // logs, and the DELETE still answers that the folder is in the trash.
    test('a close that fails after the trash still answers the DELETE with success', async () => {
        const { folder, doc, mount, lockSpy } = await restoreIntoTrashedFolder('trash-close-fails');
        const closeSpy = spyOn(mount, 'closeDatabase').mockImplementation(async () => {
            throw new ApiError(503, 'storage unavailable');
        });
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        let res: Response;
        let logged: unknown[][];
        try {
            res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/path/${folder.id}`,
                { method: 'DELETE' },
            );
        } finally {
            logged = errors.mock.calls;
            errors.mockRestore();
            closeSpy.mockRestore();
            lockSpy.mockRestore();
        }
        expect(res.status).toBe(200);
        expect((await mount.getPath(folder.id))?.trashedAt).not.toBeNull();
        expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);
        expect(logged.some((call) => String(call[0]).includes(doc.id))).toBe(true);
    });

    // Each trash refuses the opens below its own path. When a trash of a document inside the folder
    // fails, the folder's trash still refuses an open of that document.
    test('a failed trash inside a folder that is being trashed keeps the folder refusing opens', async () => {
        const folder = await home.drive.createFolder(mountId, rootId, 'trash-nested');
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${folder.id}/create/doc`,
            { fileName: 'trash-nested-doc' },
        );
        const { mount } = await home.drive.resolveFile(mountId, doc.id);
        const trashPath = mount.trashPath.bind(mount);
        let innerTrash: unknown = null;
        let lateOpen: unknown = null;
        const spy = spyOn(mount, 'trashPath')
            .mockImplementationOnce(async (pathId) => {
                innerTrash = await home.drive.deletePath(mountId, doc.id).catch((e: unknown) => e);
                lateOpen = await home.drive.getCollabDocument(mountId, doc.id).catch((e: unknown) => e);
                return trashPath(pathId);
            })
            .mockImplementationOnce(async () => {
                throw new ApiError(503, 'storage unavailable');
            });
        try {
            await home.drive.deletePath(mountId, folder.id);
        } finally {
            spy.mockRestore();
        }
        expect(innerTrash instanceof ApiError && innerTrash.status).toBe(503);
        expect(lateOpen instanceof ApiError && lateOpen.status).toBe(503);
    });
});
