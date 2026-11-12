import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { ApiError } from '../../lib/core/errors';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { drainHomeDeliveries } from '../../lib/home/home-relay';
import { driveGet, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const MOUNT = 'default';

// A trash sends nothing to the homes a path is shared with. What Bob's Shared with me lists must still match
// what Alice's ACL and trash say, whatever runs at the same time.
describe('Shared with me around a trash', () => {
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
        await drainHomeDeliveries();
    }

    async function inBobsList(pathId: string): Promise<boolean> {
        await drainHomeDeliveries();
        return (await bob.drive.getSharedPathsWithMe()).some((p) => p.id === pathId);
    }

    test('a trash that fails keeps the item in Bob’s Shared with me', async () => {
        const folder = await alice.drive.createFolder(MOUNT, rootId, `failing-trash-${Date.now()}`, alice.user);
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

    test('a share that lands while a folder goes to the trash never reaches Bob', async () => {
        const folder = await alice.drive.createFolder(MOUNT, rootId, `share-during-trash-${Date.now()}`, alice.user);
        const inner = await alice.drive.createFileFromData(
            MOUNT,
            folder.id,
            'inner.txt',
            'text/plain',
            Buffer.from('x'),
            alice.user,
        );
        const { mount } = await alice.drive.resolveFile(MOUNT, folder.id);
        // The share passes its checks before the trash, and its row write waits until the trash is in.
        let trashed!: () => void;
        const trashDone = new Promise<void>((resolve) => {
            trashed = resolve;
        });
        const updatePath = mount.updatePath.bind(mount);
        const writeSpy = spyOn(mount, 'updatePath').mockImplementationOnce(async (...args) => {
            await trashDone;
            return updatePath(...args);
        });
        const trashPath = mount.trashPath.bind(mount);
        let share: Promise<unknown> = Promise.resolve();
        const trashSpy = spyOn(mount, 'trashPath').mockImplementationOnce(async (pathId) => {
            share = shareWithBob(inner.id).catch((e: unknown) => e);
            const trashedItem = await trashPath(pathId);
            trashed();
            return trashedItem;
        });
        try {
            await alice.drive.deletePath(MOUNT, folder.id, alice.user);
        } finally {
            trashSpy.mockRestore();
            writeSpy.mockRestore();
        }
        const result = await share;

        expect(result instanceof ApiError && result.status).toBe(404);
        expect((await mount.getPath(inner.id))?.acl).toBeNull();
        expect(await inBobsList(inner.id)).toBe(false);
    });
});
