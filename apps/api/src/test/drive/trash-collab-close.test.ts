import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
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

    test('DELETE on an open .eigendoc closes it', async () => {
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'trash-close' },
        );
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
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'trash-clean' },
        );
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

    // The path stays active until trashPath writes trashedAt, so a socket can open the doc after the
    // first close. The trash closes it again once the row is trashed.
    test('a doc opened between the collab close and the trash write is closed too', async () => {
        const doc = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'trash-reopen' },
        );
        const { mount } = await home.drive.resolveFile(mountId, doc.id);
        const trashPath = mount.trashPath.bind(mount);
        const spy = spyOn(mount, 'trashPath').mockImplementation(async (pathId) => {
            await home.drive.getCollabDocument(mountId, doc.id);
            return trashPath(pathId);
        });
        try {
            await home.drive.deletePath(mountId, doc.id);
        } finally {
            spy.mockRestore();
        }
        expect(home.drive.hasCollabDocument(mountId, doc.id)).toBe(false);
    });
});
