import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Notification } from '@workspace/lib/types/notification';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { and, eq } from 'drizzle-orm';
import { getServerConfig } from '../../lib/config/server-config';
import { getSharedDatabase } from '../../lib/drive/shared';
import { sharedPaths } from '../../lib/drive/shared-schema';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { drainHomeDeliveries } from '../../lib/home/home-relay';
import * as user from '../../lib/user';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    createTeam,
    createTestUser,
    driveGet,
    firstMountId,
    getTestContext,
} from '../setup';

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

    test('the listing of one type holds only the shared paths of that type', async () => {
        const file = await sharedWithBob();
        const folder = await newFolder();
        await shareWithBob(folder.id);
        const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/mime/text-plain`);
        const ids = (await assertJson<DrivePath[]>(res)).map((path) => path.id);
        expect(ids).toContain(file.id);
        expect(ids).not.toContain(folder.id);
    });

    test('oldest share first, across owners', async () => {
        const charlie = await getHome(ctx.charlie.user.id);
        const charlieRoot = await driveGet<DrivePath>(
            ctx.charlie.user.sessionToken,
            ctx.charlie.user.id,
            MOUNT,
            'root',
        );
        const files: DrivePath[] = [];
        for (const owner of [alice, charlie, alice, charlie]) {
            const parentId = owner === alice ? rootId : charlieRoot.id;
            const name = `${crypto.randomUUID()}.txt`;
            const file = await owner.drive.createFileFromData(
                MOUNT,
                parentId,
                name,
                'text/plain',
                Buffer.from('x'),
                owner.user,
            );
            const add = [{ id: ctx.bob.user.email, read: true, write: false }];
            await owner.drive.updateACLDelta(MOUNT, file.id, { add }, undefined, undefined, owner.user);
            files.push(file);
        }
        await drainHomeDeliveries();
        // The shares get times a second apart in another order than they were made, owners taking turns.
        const sharedDb = await getSharedDatabase(bob);
        const base = Date.now() - 60_000;
        for (const [i, file] of [files[2], files[1], files[0], files[3]].entries()) {
            sharedDb
                .update(sharedPaths)
                .set({ sharedAt: new Date(base + i * 1000) })
                .where(eq(sharedPaths.pathId, file.id))
                .run();
        }

        const res = await authedRequest(ctx.bob.user.sessionToken, `/drive/${ctx.bob.user.id}/shared/with-me`);
        const ids = new Set(files.map((file) => file.id));
        const listed = (await assertJson<DrivePath[]>(res)).map((path) => path.id).filter((id) => ids.has(id));
        expect(listed).toEqual([files[2].id, files[1].id, files[0].id, files[3].id]);
    });

    test('a home nobody shared with reads no memberships', async () => {
        const loner = await createTestUser('shared-with-me-loner@test.eigen.is', 'testpassword123', 'Loner');
        const home = await getHome(loner.id);
        const memberships = spyOn(user, 'getMemberships');
        try {
            expect(await home.drive.getSharedPathsWithMe()).toEqual([]);
            expect(memberships).not.toHaveBeenCalled();
        } finally {
            memberships.mockRestore();
        }
    });
});

describe('Shared with me never lists what the user owns', () => {
    let ctx: TestCtx;
    let teamId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()?.orgId;
        if (!orgId) throw new Error('the test server has no org');
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        teamId = await createTeam(ctx, orgId, `Own shares ${crypto.randomUUID()}`);
        await addMember(ctx, teamId, ctx.alice.user.id);
        await addMember(ctx, teamId, ctx.bob.user.id);
        await addTeamMount(ctx, teamId, 'Own shares drive');
    });

    async function listedAndBell(token: string, userId: string, name: string): Promise<[boolean, string[]]> {
        const res = await authedRequest(token, `/drive/${userId}/shared/with-me`);
        const listed = (await assertJson<DrivePath[]>(res)).some((path) => path.name === name);
        const bell = await assertJson<Notification[]>(await authedRequest(token, `/notifications/${userId}?limit=100`));
        return [listed, bell.filter((notification) => notification.body === name).map((n) => n.title)];
    }

    test('a file its owner shares with their own team reaches the other members only', async () => {
        const alice = await getHome(ctx.alice.user.id);
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, 'root');
        const name = `${crypto.randomUUID()}.txt`;
        const file = await alice.drive.createFileFromData(
            MOUNT,
            root.id,
            name,
            'text/plain',
            Buffer.from('x'),
            alice.user,
        );
        const add = [{ id: teamOwnerId(teamId), read: true, write: false }];
        await alice.drive.updateACLDelta(MOUNT, file.id, { add }, undefined, undefined, alice.user);
        await drainHomeDeliveries();

        expect(await listedAndBell(ctx.alice.user.sessionToken, ctx.alice.user.id, name)).toEqual([false, []]);
        expect((await listedAndBell(ctx.bob.user.sessionToken, ctx.bob.user.id, name))[0]).toBe(true);
    });

    test('a team file shared with a member by address stays in the team drive only', async () => {
        const owner = teamOwnerId(teamId);
        const team = await getHome(owner);
        const { user: alice } = await getHome(ctx.alice.user.id);
        const mountId = await firstMountId(ctx.alice.user.sessionToken, owner);
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, owner, mountId, 'root');
        const name = `${crypto.randomUUID()}.txt`;
        const file = await team.drive.createFileFromData(mountId, root.id, name, 'text/plain', Buffer.from('x'), alice);
        const add = [{ id: ctx.bob.user.email, read: true, write: false }];
        await team.drive.updateACLDelta(mountId, file.id, { add }, undefined, undefined, alice);
        await drainHomeDeliveries();

        expect(await listedAndBell(ctx.bob.user.sessionToken, ctx.bob.user.id, name)).toEqual([false, []]);
    });

    test('a share from before joining the team leaves without a notice, and a real unshare still tells', async () => {
        const owner = teamOwnerId(teamId);
        const team = await getHome(owner);
        const alice = await getHome(ctx.alice.user.id);
        const charlie = await getHome(ctx.charlie.user.id);
        const mountId = await firstMountId(ctx.alice.user.sessionToken, owner);
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, owner, mountId, 'root');
        const name = `${crypto.randomUUID()}.txt`;
        const file = await team.drive.createFileFromData(
            mountId,
            root.id,
            name,
            'text/plain',
            Buffer.from('x'),
            alice.user,
        );
        const add = [{ id: ctx.charlie.user.email, read: true, write: false }];
        await team.drive.updateACLDelta(mountId, file.id, { add }, undefined, undefined, alice.user);
        await drainHomeDeliveries();
        const sharedDb = await getSharedDatabase(charlie);
        const row = () => sharedDb.select().from(sharedPaths).where(eq(sharedPaths.pathId, file.id)).get();
        expect(row()).toBeDefined();
        await addMember(ctx, teamId, ctx.charlie.user.id);
        await drainHomeDeliveries();

        const write = [{ id: ctx.charlie.user.email, read: true, write: true }];
        await team.drive.updateACLDelta(mountId, file.id, { add: write }, undefined, undefined, alice.user);
        await drainHomeDeliveries();
        expect(row()).toBeUndefined();
        const [, titles] = await listedAndBell(ctx.charlie.user.sessionToken, ctx.charlie.user.id, name);
        expect(titles.filter((title) => title.endsWith('removed your access'))).toEqual([]);

        const rootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, 'root')).id;
        const other = `${crypto.randomUUID()}.txt`;
        const own = await alice.drive.createFileFromData(
            MOUNT,
            rootId,
            other,
            'text/plain',
            Buffer.from('x'),
            alice.user,
        );
        await alice.drive.updateACLDelta(MOUNT, own.id, { add }, undefined, undefined, alice.user);
        await drainHomeDeliveries();
        const remove = [ctx.charlie.user.email];
        await alice.drive.updateACLDelta(MOUNT, own.id, { remove }, undefined, undefined, alice.user);
        await drainHomeDeliveries();
        const [, otherTitles] = await listedAndBell(ctx.charlie.user.sessionToken, ctx.charlie.user.id, other);
        expect(otherTitles.filter((title) => title.endsWith('removed your access'))).toHaveLength(1);
    });
});
