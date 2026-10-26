import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../../lib/core/errors';
import { drainACLFanOuts } from '../../lib/drive/acl-propagation';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { driveGet, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const MOUNT = 'default';

// A trash, a restore and a rename send the path's sharing to the homes it is shared with. What Bob's
// Shared with me lists must match what Alice's ACL says, whatever runs at the same time.
describe('sharing pushed by a trash, a restore or a rename', () => {
    let ctx: TestCtx;
    let alice: Home;
    let bob: Home;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        alice = await getHome(ctx.alice.user.id);
        bob = await getHome(ctx.bob.user.id);
        rootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, 'root')).id;
    });

    async function shareWithBob(pathId: string): Promise<void> {
        await alice.drive.updateACLDelta(
            MOUNT,
            pathId,
            { add: [{ id: ctx.bob.user.email, read: true, write: false }] },
            undefined,
            undefined,
            alice.user,
        );
        await drainACLFanOuts();
    }

    async function inBobsList(pathId: string): Promise<boolean> {
        await drainACLFanOuts();
        return (await bob.drive.getSharedPathsWithMe()).some((p) => p.id === pathId);
    }

    test('a trash that fails keeps the item in Bob’s Shared with me', async () => {
        const folder = await alice.drive.createFolder(MOUNT, rootId, `failing-trash-${Date.now()}`);
        await shareWithBob(folder.id);
        expect(await inBobsList(folder.id)).toBe(true);

        const { mount } = await alice.drive.resolveFile(MOUNT, folder.id);
        const spy = spyOn(mount, 'trashPath').mockImplementationOnce(async () => {
            throw new ApiError(503, 'storage unavailable');
        });
        const result = await alice.drive.deletePath(MOUNT, folder.id, alice.user).catch((e: unknown) => e);
        spy.mockRestore();

        expect(result instanceof ApiError && result.status).toBe(503);
        expect((await mount.getPath(folder.id))?.trashedAt).toBeNull();
        expect(await inBobsList(folder.id)).toBe(true);
    });
});
