import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import { getMountQuotaState } from '../../lib/config/enforcement';
import { getServerConfig } from '../../lib/config/server-config';
import { authedRequest, getTestContext } from '../setup';

// A mount's cap belongs to the mount: the same mount meets the same cap, WebDAV reports the same quota,
// whoever writes or looks.
describe('a mount cap takes the team overrides of the mount owner', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    const teamIds: string[] = [];

    async function createTeam(name: string, memberId: string, defaultMountMaxSizeMB: number): Promise<void> {
        const res = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, organizationId: getServerConfig()!.orgId }),
        });
        const { id } = (await res.json()) as { id: string };
        teamIds.push(id);
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: id, userId: memberId }),
        });
        await setOverride(id, defaultMountMaxSizeMB);
    }

    function setOverride(teamId: string, defaultMountMaxSizeMB: number | null): Promise<Response> {
        return authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { defaultMountMaxSizeMB } }),
        });
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: getServerConfig()!.orgId }),
        });
    });

    afterAll(async () => {
        for (const teamId of teamIds) await setOverride(teamId, null);
    });

    test("a writer's teams do not lift the owner's mount", async () => {
        const ownCap = (await getMountQuotaState(ctx.alice.user.id, ctx.alice.user.id, mountId)).max;
        await createTeam('Writer Override Team', ctx.bob.user.id, 5000);

        const asBob = await getMountQuotaState(ctx.alice.user.id, ctx.bob.user.id, mountId);
        expect(asBob.max).toBe(ownCap);
    });

    test("the owner's teams lift the mount whoever writes", async () => {
        await createTeam('Owner Override Team', ctx.alice.user.id, 3000);

        const asBob = await getMountQuotaState(ctx.alice.user.id, ctx.bob.user.id, mountId);
        expect(asBob.max).toBe(3000 * 1024 * 1024);
    });
});
