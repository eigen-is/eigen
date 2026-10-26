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

    async function sharedWithBob(name: string): Promise<DrivePath> {
        const file = await alice.drive.createFileFromData(MOUNT, rootId, name, 'text/plain', Buffer.from('x'));
        await shareWithBob(file.id);
        return file;
    }

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

    test('a revoke while a restore records its history keeps Bob out of Shared with me', async () => {
        const file = await sharedWithBob(`restore-revoke-${Date.now()}.txt`);
        await alice.drive.deletePath(MOUNT, file.id, alice.user);
        expect(await inBobsList(file.id)).toBe(false);

        const record = alice.drive.recordFileEvent.bind(alice.drive);
        const spy = spyOn(alice.drive, 'recordFileEvent').mockImplementationOnce(async (...args) => {
            await alice.drive.updateACLDelta(
                MOUNT,
                file.id,
                { remove: [ctx.bob.user.email] },
                undefined,
                undefined,
                alice.user,
            );
            return record(...args);
        });
        try {
            await alice.drive.restorePath(MOUNT, file.id, alice.user);
        } finally {
            spy.mockRestore();
        }

        expect((await alice.drive.getPath(MOUNT, file.id))?.acl).toBeNull();
        expect(await inBobsList(file.id)).toBe(false);
    });

    test('a revoke while a rename records its history keeps Bob out of Shared with me', async () => {
        const file = await sharedWithBob(`rename-revoke-${Date.now()}.txt`);
        expect(await inBobsList(file.id)).toBe(true);

        const record = alice.drive.recordFileEvent.bind(alice.drive);
        const spy = spyOn(alice.drive, 'recordFileEvent').mockImplementationOnce(async (...args) => {
            await alice.drive.updateACLDelta(
                MOUNT,
                file.id,
                { remove: [ctx.bob.user.email] },
                undefined,
                undefined,
                alice.user,
            );
            return record(...args);
        });
        try {
            await alice.drive.renamePath(MOUNT, file.id, `renamed-${file.name}`, alice.user);
        } finally {
            spy.mockRestore();
        }

        expect(await inBobsList(file.id)).toBe(false);
    });

    test('a share that lands while a folder goes to the trash never reaches Bob', async () => {
        const folder = await alice.drive.createFolder(MOUNT, rootId, `share-during-trash-${Date.now()}`);
        const inner = await alice.drive.createFileFromData(
            MOUNT,
            folder.id,
            'inner.txt',
            'text/plain',
            Buffer.from('x'),
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
