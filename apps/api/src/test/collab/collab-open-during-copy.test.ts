import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../../lib/core/errors';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { driveGet, drivePost, getTestContext } from '../setup';

// A copy makes the new container before it copies data.db into it. A socket that opens the copy in
// between must not make a data.db of its own, or the copy's data.db can't land.
describe('opening a document copy before its data.db lands', () => {
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

    test('is refused with a 503, and the copy completes with the source content', async () => {
        const source = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'copy-source' },
        );
        const collab = await home.drive.getCollabDocument(mountId, source.id);
        collab.doc.getMap('state').set('marker', 'copied');
        await home.drive.closeCollabDocument(mountId, source.id);

        const { mount } = await home.drive.resolveFile(mountId, source.id);
        const createFolder = mount.createFolder.bind(mount);
        let earlyOpen: unknown = null;
        const spy = spyOn(mount, 'createFolder').mockImplementationOnce(async (...args) => {
            const containerId = await createFolder(...args);
            earlyOpen = await home.drive.getCollabDocument(mountId, containerId).catch((e: unknown) => e);
            return containerId;
        });
        let copy: DrivePath;
        try {
            copy = await home.drive.copyPath(mountId, source.id, rootId, 'copy-source copy');
        } finally {
            spy.mockRestore();
        }

        expect(earlyOpen).toBeInstanceOf(ApiError);
        expect(earlyOpen instanceof ApiError && earlyOpen.status).toBe(503);
        const copied = await home.drive.getCollabDocument(mountId, copy.id);
        expect(copied.doc.getMap('state').get('marker')).toBe('copied');
    });
});
