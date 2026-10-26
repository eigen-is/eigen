import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CollabDocument } from '../../lib/collab/collab-document';
import { ApiError } from '../../lib/core/errors';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
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

    // A move that passed its checks before the trash began can still land in the folder. Its document
    // was open outside the folder, so the trash closes it afterwards, and no stale copy is served.
    test('a document moved into the folder while it is trashed is closed, and edits after the restore persist', async () => {
        const folder = await home.drive.createFolder(mountId, rootId, 'trash-move-in');
        const doc = await createDoc('trash-move-in-doc');
        const collab = await home.drive.getCollabDocument(mountId, doc.id);
        collab.doc.getMap('state').set('before', 'kept');
        const { mount } = await home.drive.resolveFile(mountId, doc.id);
        const trashPath = mount.trashPath.bind(mount);
        const spy = spyOn(mount, 'trashPath').mockImplementationOnce(async (pathId) => {
            await mount.updatePath(doc.id, { parentId: folder.id });
            return trashPath(pathId);
        });
        try {
            await home.drive.deletePath(mountId, folder.id);
        } finally {
            spy.mockRestore();
        }
        expect((await mount.getPath(doc.id))?.trashedAt).not.toBeNull();
        expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);

        await home.drive.restorePath(mountId, folder.id);
        const reopened = await home.drive.getCollabDocument(mountId, doc.id);
        expect(reopened).not.toBe(collab);
        reopened.doc.getMap('state').set('afterRestore', 'typed');
        await home.drive.closeCollabDocument(mountId, doc.id);
        const fresh = await home.drive.getCollabDocument(mountId, doc.id);
        expect(fresh.doc.getMap('state').toJSON()).toEqual({ before: 'kept', afterRestore: 'typed' });
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
