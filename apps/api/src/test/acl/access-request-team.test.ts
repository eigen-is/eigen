import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { Notification } from '@workspace/lib/types/notification';
import { getServerConfig } from '../../lib/config/server-config';
import type { TestContext, TestUser } from '../setup';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    createTeam,
    driveGet,
    drivePost,
    eventually,
    firstMountId,
    getTestContext,
} from '../setup';

let ctx: TestContext;
let teamOwner: string;
let teamMountId: string;
let teamRootId: string;

beforeAll(async () => {
    ctx = await getTestContext();
    const orgId = getServerConfig()!.orgId;
    await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId }),
    });

    // Alice and Charlie are members; Bob is not.
    const teamId = await createTeam(ctx, orgId, 'Access Request Team');
    teamOwner = teamOwnerId(teamId);
    await addMember(ctx, teamId, ctx.alice.user.id);
    await addMember(ctx, teamId, ctx.charlie.user.id);
    await addTeamMount(ctx, teamId, 'Access Request Drive');
    teamMountId = await firstMountId(ctx.charlie.user.sessionToken, teamOwner);
    teamRootId = (await driveGet(ctx.charlie.user.sessionToken, teamOwner, teamMountId, 'root')).id;
});

afterEach(() => setNotifyMembers(true));

function setNotifyMembers(notifyMembers: boolean): Promise<Response> {
    return authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwner}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifyMembers }),
    });
}

async function createTeamDoc(name: string): Promise<{ id: string }> {
    return drivePost(ctx.charlie.user.sessionToken, teamOwner, teamMountId, `folder/${teamRootId}/create/doc`, {
        fileName: name,
    });
}

function requestAccess(pathId: string, requester: TestUser): Promise<Response> {
    return authedRequest(requester.sessionToken, `/drive/${teamOwner}/${teamMountId}/path/${pathId}/request-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Please' }),
    });
}

function tagFor(pathId: string, requester: TestUser): string {
    return `access-request:${teamOwner}:${teamMountId}:${pathId}:${requester.email}`;
}

async function rowsTagged(user: TestUser, tag: string): Promise<Notification[]> {
    const rows = await assertJson<Notification[]>(await authedRequest(user.sessionToken, `/notifications/${user.id}`));
    return rows.filter((row) => row.tag === tag);
}

async function catchMail() {
    const mailer = await import('../../lib/mailer/mailer');
    const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
    spy.mockClear();
    return {
        spy,
        to: (user: TestUser) => spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === user.email)),
    };
}

describe('An access request on a team drive', () => {
    test('a team without the setting notifies and mails every member', async () => {
        const settings = await assertJson<Record<string, unknown>>(
            await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwner}/settings`),
        );
        expect(settings['notifyMembers']).toBeUndefined();

        const { spy, to } = await catchMail();
        const doc = await createTeamDoc('team-request-on');
        expect((await requestAccess(doc.id, ctx.bob.user)).status).toBe(200);
        // The mails go out after the rows, so they mark the fan-out done.
        await eventually(async () => (to(ctx.alice.user).length && to(ctx.charlie.user).length ? true : undefined));

        const tag = tagFor(doc.id, ctx.bob.user);
        expect(await rowsTagged(ctx.alice.user, tag)).toHaveLength(1);
        expect(await rowsTagged(ctx.charlie.user, tag)).toHaveLength(1);
        expect(await rowsTagged(ctx.bob.user, tag)).toHaveLength(0);
        expect(to(ctx.alice.user)).toHaveLength(1);
        expect(to(ctx.charlie.user)).toHaveLength(1);
        expect(to(ctx.bob.user)).toHaveLength(0);
        spy.mockRestore();
    });

    test('a member who asks is not told about their own request', async () => {
        const { spy, to } = await catchMail();
        const doc = await createTeamDoc('team-request-self');
        await requestAccess(doc.id, ctx.alice.user);
        await eventually(async () => (to(ctx.charlie.user).length ? true : undefined));

        const tag = tagFor(doc.id, ctx.alice.user);
        expect(await rowsTagged(ctx.alice.user, tag)).toHaveLength(0);
        expect(await rowsTagged(ctx.charlie.user, tag)).toHaveLength(1);
        expect(to(ctx.alice.user)).toHaveLength(0);
        expect(to(ctx.charlie.user)).toHaveLength(1);
        spy.mockRestore();
    });

    test("a member's failed mail is retried for that member alone", async () => {
        const { spy, to } = await catchMail();
        let aliceFailed = false;
        spy.mockImplementation(async (mail) => {
            if (aliceFailed || !mail.to.some((t) => t.address === ctx.alice.user.email)) return true;
            aliceFailed = true;
            return false;
        });
        const doc = await createTeamDoc('team-request-retry');
        await requestAccess(doc.id, ctx.bob.user);
        await eventually(async () => (to(ctx.alice.user).length && to(ctx.charlie.user).length ? true : undefined));
        await requestAccess(doc.id, ctx.bob.user);

        await eventually(async () => (to(ctx.alice.user).length === 2 ? true : undefined), "Alice's retry");
        expect(to(ctx.charlie.user)).toHaveLength(1);
        spy.mockRestore();
    });

    test('with the setting off nobody gets a row or a mail', async () => {
        expect((await setNotifyMembers(false)).status).toBe(200);
        const { spy } = await catchMail();
        const doc = await createTeamDoc('team-request-off');
        expect((await requestAccess(doc.id, ctx.bob.user)).status).toBe(200);
        await new Promise((r) => setTimeout(r, 100));

        const tag = tagFor(doc.id, ctx.bob.user);
        expect(await rowsTagged(ctx.alice.user, tag)).toHaveLength(0);
        expect(await rowsTagged(ctx.charlie.user, tag)).toHaveLength(0);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
