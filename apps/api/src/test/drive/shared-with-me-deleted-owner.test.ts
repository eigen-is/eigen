import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Notification } from '@workspace/lib/types/notification';
import { eq } from 'drizzle-orm';
import { getPublicConfig } from '../../lib/config/server-config';
import { getSharedDatabase } from '../../lib/drive/shared';
import { sharedPaths } from '../../lib/drive/shared-schema';
import { getHome } from '../../lib/home/get-home';
import * as userModule from '../../lib/user/user';
import type { TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    createTeam,
    createTestUser,
    driveGet,
    drivePut,
    driveUpload,
    eventually,
    firstMountId,
    getTestContext,
} from '../setup';

// A distinctive type, so the type listing holds only this file's shares. The route swaps the first hyphen only.
const MIME = 'application/x-eigen-deleted-owner';
const MIME_SEGMENT = 'application-x-eigen-deleted-owner';

describe('Shared with me leaves out the items of a deleted owner', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let orgId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        orgId = getPublicConfig().orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
    });

    afterEach(() => mock.restore());

    async function newOwner(): Promise<TestUser> {
        const owner = await createTestUser(`owner-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Owner');
        await getHome(owner.id);
        return owner;
    }

    function deleteUser(user: TestUser): Promise<Response> {
        return authedRequest(ctx.alice.user.sessionToken, `/settings/user/${user.id}`, { method: 'DELETE' });
    }

    async function newTeam(): Promise<{ teamId: string; ownerId: string }> {
        const teamId = await createTeam(ctx, orgId, `Team ${crypto.randomUUID()}`);
        await addMember(ctx, teamId, ctx.alice.user.id);
        await addTeamMount(ctx, teamId, 'Drive');
        return { teamId, ownerId: teamOwnerId(teamId) };
    }

    function deleteTeam(teamId: string): Promise<Response> {
        return authedRequest(ctx.alice.user.sessionToken, '/auth/organization/remove-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, organizationId: orgId }),
        });
    }

    // Answers once the recipient's home has the row, which a fan-out delivers a moment after the save.
    async function share(token: string, ownerId: string, recipient: TestUser): Promise<DrivePath> {
        const mountId = await firstMountId(token, ownerId);
        const root = await driveGet(token, ownerId, mountId, 'root');
        const file = new File(['shared'], `${crypto.randomUUID()}.bin`, { type: MIME });
        const path = await driveUpload(token, ownerId, mountId, root.id, file);
        await drivePut(token, ownerId, mountId, `path/${path.id}/acl`, {
            add: [{ id: recipient.email, read: true, write: false }],
        });
        await eventually(async () => ((await sharedRows(recipient, ownerId)).length > 0 ? true : undefined), 'the row');
        return path;
    }

    async function sharedRows(recipient: TestUser, ownerId: string) {
        const sharedDb = await getSharedDatabase(await getHome(recipient.id));
        return sharedDb.select().from(sharedPaths).where(eq(sharedPaths.ownerId, ownerId)).all();
    }

    function listShared(recipient: TestUser): Promise<Response> {
        return authedRequest(recipient.sessionToken, `/drive/${recipient.id}/shared/with-me`);
    }

    async function sharedIds(recipient: TestUser): Promise<string[]> {
        return (await assertJson<DrivePath[]>(await listShared(recipient))).map((path) => path.id);
    }

    async function mimeIds(recipient: TestUser): Promise<string[]> {
        const res = await authedRequest(recipient.sessionToken, `/drive/${recipient.id}/mime/${MIME_SEGMENT}`);
        return (await assertJson<DrivePath[]>(res)).map((path) => path.id);
    }

    async function bell(recipient: TestUser): Promise<Notification[]> {
        return assertJson<Notification[]>(
            await authedRequest(recipient.sessionToken, `/notifications/${recipient.id}?limit=100`),
        );
    }

    test("a deleted user's item leaves the list, with no bell row", async () => {
        const { bob } = ctx;
        const owner = await newOwner();
        const path = await share(owner.sessionToken, owner.id, bob.user);
        expect(await sharedIds(bob.user)).toContain(path.id);
        const bellBefore = await bell(bob.user);

        expect((await deleteUser(owner)).status).toBe(200);

        expect(await sharedIds(bob.user)).not.toContain(path.id);
        expect(await bell(bob.user)).toEqual(bellBefore);
    });

    test("a deleted team's item leaves the list, with no bell row", async () => {
        const { alice, bob } = ctx;
        const { teamId, ownerId } = await newTeam();
        const path = await share(alice.user.sessionToken, ownerId, bob.user);
        expect(await sharedIds(bob.user)).toContain(path.id);
        const bellBefore = await bell(bob.user);

        expect((await deleteTeam(teamId)).status).toBe(200);

        expect(await sharedIds(bob.user)).not.toContain(path.id);
        expect(await bell(bob.user)).toEqual(bellBefore);
    });

    test('the listing of one type leaves out the same items', async () => {
        const { alice, charlie } = ctx;
        const owner = await newOwner();
        const { teamId, ownerId: team } = await newTeam();
        const ofUser = await share(owner.sessionToken, owner.id, charlie.user);
        const ofTeam = await share(alice.user.sessionToken, team, charlie.user);
        expect(await mimeIds(charlie.user)).toEqual(expect.arrayContaining([ofUser.id, ofTeam.id]));

        expect((await deleteUser(owner)).status).toBe(200);
        expect((await deleteTeam(teamId)).status).toBe(200);

        const listed = await mimeIds(charlie.user);
        expect(listed).not.toContain(ofUser.id);
        expect(listed).not.toContain(ofTeam.id);
    });

    test('a listing with a mix leaves out only the deleted owners, and keeps every row', async () => {
        const { alice, bob } = ctx;
        const live = await newOwner();
        const liveTeam = await newTeam();
        const doomed = await newOwner();
        const doomedTeam = await newTeam();
        const kept = [
            await share(live.sessionToken, live.id, bob.user),
            await share(alice.user.sessionToken, liveTeam.ownerId, bob.user),
        ];
        const dropped = [
            await share(doomed.sessionToken, doomed.id, bob.user),
            await share(alice.user.sessionToken, doomedTeam.ownerId, bob.user),
        ];

        expect((await deleteUser(doomed)).status).toBe(200);
        expect((await deleteTeam(doomedTeam.teamId)).status).toBe(200);

        const listed = await sharedIds(bob.user);
        expect(listed).toEqual(expect.arrayContaining(kept.map((path) => path.id)));
        for (const path of dropped) expect(listed).not.toContain(path.id);
        for (const ownerId of [live.id, liveTeam.ownerId, doomed.id, doomedTeam.ownerId]) {
            expect(await sharedRows(bob.user, ownerId)).toHaveLength(1);
        }
    });

    test('an owner lookup that throws leaves only that owner out, and the item is back at the next listing', async () => {
        const { bob } = ctx;
        const owner = await newOwner();
        const other = await newOwner();
        const path = await share(owner.sessionToken, owner.id, bob.user);
        const ofOther = await share(other.sessionToken, other.id, bob.user);

        const getUserById = userModule.getUserById;
        spyOn(userModule, 'getUserById').mockImplementation(async (id) => {
            if (id === owner.id) throw new Error('users3.db is unreadable');
            return getUserById(id);
        });
        const logged = spyOn(console, 'error').mockImplementation(() => {});
        const listed = await sharedIds(bob.user);
        expect(listed).not.toContain(path.id);
        expect(listed).toContain(ofOther.id);
        expect(logged).toHaveBeenCalled();

        mock.restore();
        expect(await sharedIds(bob.user)).toContain(path.id);
    });

    test('a row whose owner is neither a user nor a team lists nothing and fails no listing', async () => {
        const { bob } = ctx;
        const owner = await newOwner();
        const path = await share(owner.sessionToken, owner.id, bob.user);
        const orgOwner = `org_${crypto.randomUUID().replaceAll('-', '')}`;
        const sharedDb = await getSharedDatabase(await getHome(bob.user.id));
        const pointer = { ownerId: orgOwner, mountId: 'm', pathId: crypto.randomUUID() };
        sharedDb
            .insert(sharedPaths)
            .values({ ...pointer, sharedAt: new Date() })
            .run();
        spyOn(console, 'error').mockImplementation(() => {});

        const listed = await sharedIds(bob.user);
        expect(listed).toContain(path.id);
        expect(listed).not.toContain(pointer.pathId);
        sharedDb.delete(sharedPaths).where(eq(sharedPaths.ownerId, orgOwner)).run();
    });
});
