import { beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { TeamSettings } from '@workspace/lib/types/settings';
import { getServerConfig } from '../../lib/config/server-config';
import { addMember, assertJson, authedRequest, createTeam, getTestContext } from '../setup';

describe('Team settings', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let ownerId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        const teamId = await createTeam(ctx, orgId, 'Settings Team');
        ownerId = teamOwnerId(teamId);
        await addMember(ctx, teamId, ctx.bob.user.id);
    });

    function putSettings(token: string, body: TeamSettings): Promise<Response> {
        return authedRequest(token, `/team/${ownerId}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    test('notifyMembers round-trips', async () => {
        expect((await putSettings(ctx.alice.user.sessionToken, { notifyMembers: false })).status).toBe(200);
        const settings = await assertJson<TeamSettings>(
            await authedRequest(ctx.bob.user.sessionToken, `/team/${ownerId}/settings`),
        );
        expect(settings.notifyMembers).toBe(false);
    });

    test('a PUT without memberOverrides keeps the saved ones', async () => {
        const overrides = { mailAndContactsMaxMB: 50, defaultMountMaxSizeMB: 20 };
        expect((await putSettings(ctx.alice.user.sessionToken, { memberOverrides: overrides })).status).toBe(200);
        expect((await putSettings(ctx.alice.user.sessionToken, { notifyMembers: true })).status).toBe(200);
        const settings = await assertJson<TeamSettings>(
            await authedRequest(ctx.alice.user.sessionToken, `/team/${ownerId}/settings`),
        );
        expect(settings.memberOverrides).toEqual(overrides);
    });

    test('a member who is not an org admin cannot change them', async () => {
        expect((await putSettings(ctx.bob.user.sessionToken, { notifyMembers: true })).status).toBe(403);
    });
});
