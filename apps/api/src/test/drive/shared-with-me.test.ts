import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Notification } from '@workspace/lib/types/notification';
import { and, eq } from 'drizzle-orm';
import { getSharedDatabase } from '../../lib/drive/shared';
import { sharedPaths } from '../../lib/drive/sharedschema';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { drainHomeDeliveries } from '../../lib/home/home-relay';
import { assertJson, authedRequest, driveGet, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

const MOUNT = 'default';

describe('Shared with me reads each row from its owner', () => {
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

    function newFile(parentId = rootId): Promise<DrivePath> {
        const name = `${crypto.randomUUID()}.txt`;
        return alice.drive.createFileFromData(MOUNT, parentId, name, 'text/plain', Buffer.from('x'), alice.user);
    }

    function newFolder(): Promise<DrivePath> {
        return alice.drive.createFolder(MOUNT, rootId, crypto.randomUUID(), alice.user);
    }

    async function shareWithBob(pathId: string, write = false): Promise<void> {
        const add = [{ id: ctx.bob.user.email, read: true, write }];
        await alice.drive.updateACLDelta(MOUNT, pathId, { add }, undefined, undefined, alice.user);
        await drainHomeDeliveries();
    }

    async function sharedWithBob(parentId = rootId): Promise<DrivePath> {
        const file = await newFile(parentId);
        await shareWithBob(file.id);
        return file;
    }

    async function listed(pathId: string): Promise<DrivePath | undefined> {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
        return (await assertJson<DrivePath[]>(res)).find((path) => path.id === pathId);
    }

    async function bobsRow(pathId: string) {
        const sharedDb = await getSharedDatabase(bob);
        return sharedDb
            .select()
            .from(sharedPaths)
            .where(and(eq(sharedPaths.ownerId, alice.user.id), eq(sharedPaths.pathId, pathId)))
            .get();
    }

    async function bobsBell(body: string): Promise<Notification[]> {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}?limit=100`);
        return (await assertJson<Notification[]>(res)).filter((notification) => notification.body === body);
    }

    test('a moved file shows in its new folder', async () => {
        const file = await sharedWithBob();
        const folder = await newFolder();
        await alice.drive.movePath(MOUNT, file.id, folder.id, alice.user);
        expect((await listed(file.id))?.parentId).toBe(folder.id);
    });

    test('a file with new content shows its new size', async () => {
        const file = await sharedWithBob();
        await alice.drive.writeFileContent(MOUNT, file.id, Buffer.from('twelve bytes'), { user: alice.user });
        expect((await listed(file.id))?.size).toBe(12);
    });

    test('a new thumbnail shows', async () => {
        const file = await sharedWithBob();
        const { mount } = await alice.drive.resolveFile(MOUNT, file.id);
        await mount.updatePath(file.id, { thumbnail: 'made-later.webp' });
        expect((await listed(file.id))?.thumbnail).toBe('made-later.webp');
    });

    test('a revoke takes the file off the list and deletes the row', async () => {
        const file = await sharedWithBob();
        expect(await listed(file.id)).toBeDefined();
        const remove = [ctx.bob.user.email];
        await alice.drive.updateACLDelta(MOUNT, file.id, { remove }, undefined, undefined, alice.user);
        expect(await listed(file.id)).toBeUndefined();
        expect(await bobsRow(file.id)).toBeUndefined();
    });

    test('a trash hides the file, and a restore shows it again with its share date and no new notice', async () => {
        const file = await sharedWithBob();
        const row = await bobsRow(file.id);
        const bell = await bobsBell(file.name);
        expect(row).toBeDefined();

        await alice.drive.deletePath(MOUNT, file.id, alice.user);
        expect(await listed(file.id)).toBeUndefined();

        await alice.drive.restorePath(MOUNT, file.id, alice.user);
        expect(await listed(file.id)).toBeDefined();
        expect(await bobsRow(file.id)).toEqual(row);
        expect(await bobsBell(file.name)).toEqual(bell);
    });

    test('a trashed folder hides the shared file inside it, and its restore shows it again', async () => {
        const folder = await newFolder();
        const file = await sharedWithBob(folder.id);
        await alice.drive.deletePath(MOUNT, folder.id, alice.user);
        expect(await listed(file.id)).toBeUndefined();

        await alice.drive.restorePath(MOUNT, folder.id, alice.user);
        expect(await listed(file.id)).toBeDefined();
    });

    test('a file deleted for good leaves the list', async () => {
        const file = await sharedWithBob();
        await alice.drive.deletePath(MOUNT, file.id, alice.user);
        await alice.drive.permanentlyDelete(MOUNT, file.id, alice.user);
        expect(await listed(file.id)).toBeUndefined();
    });

    test('a second push of the same share keeps the share date', async () => {
        const file = await sharedWithBob();
        const row = await bobsRow(file.id);
        expect(row?.sharedAt).toBeInstanceOf(Date);
        await Bun.sleep(1100);
        await shareWithBob(file.id, true);
        expect(await bobsRow(file.id)).toEqual(row);
    });

    test('a row naming a path its user may not read lists nothing', async () => {
        const file = await newFile();
        const sharedDb = await getSharedDatabase(bob);
        const pointer = { ownerId: alice.user.id, mountId: MOUNT, pathId: file.id };
        sharedDb
            .insert(sharedPaths)
            .values({ ...pointer, sharedAt: new Date() })
            .run();
        expect(await listed(file.id)).toBeUndefined();
        await shareWithBob(file.id);
        expect(await listed(file.id)).toBeDefined();
    });
});
