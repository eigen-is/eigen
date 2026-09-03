import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { authedRequest, driveGet, drivePost, getTestContext } from '../setup';

// Trashing an open eigendoc must tear the collab document down BEFORE trashedAt lands —
// the teardown walks listFolderAll, which no longer sees the trashed rows.
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
});
