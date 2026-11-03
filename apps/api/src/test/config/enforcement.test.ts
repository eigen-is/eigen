import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import { getMountQuotaState } from '../../lib/config/enforcement';
import { resolveUserQuotas } from '../../lib/config/quota';
import { getServerConfig } from '../../lib/config/server-config';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { addMember, authedRequest, createTeam, getTestContext } from '../setup';

// A mount's cap belongs to the mount: the same mount meets the same cap, WebDAV reports the same quota,
// whoever writes or looks.
describe('a mount cap takes the team overrides of the mount owner', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    const teamIds: string[] = [];

    async function teamWithOverride(name: string, memberId: string, defaultMountMaxSizeMB: number): Promise<void> {
        const id = await createTeam(ctx, getServerConfig()!.orgId, name);
        teamIds.push(id);
        await addMember(ctx, id, memberId);
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
        const ownCap = (await getMountQuotaState(ctx.alice.user.id, mountId)).max;
        await teamWithOverride('Writer Override Team', ctx.bob.user.id, 5000);

        expect((await getMountQuotaState(ctx.alice.user.id, mountId)).max).toBe(ownCap);
    });

    test("the owner's teams lift the mount", async () => {
        await teamWithOverride('Owner Override Team', ctx.alice.user.id, 3000);

        expect((await getMountQuotaState(ctx.alice.user.id, mountId)).max).toBe(3000 * 1024 * 1024);
    });
});

// A user's drive is stamped with the server default at the first sign-in, and nothing edits the stamp after, so a
// raised default must still reach it. A team's drive has the cap an admin set on it.
describe('a raised server default lifts a user drive, never a team drive', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let before: number;
    const MB = 1024 * 1024;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;
        before = getServerSettings().quotas.defaultMountMaxSizeMB;
    });

    afterAll(async () => {
        await updateServerSettings({ quotas: { defaultMountMaxSizeMB: before } });
    });

    test("a user's stamped drive takes a default raised past its stamp", async () => {
        const stamped = (await getMountQuotaState(ctx.alice.user.id, mountId)).max / MB;
        await updateServerSettings({ quotas: { defaultMountMaxSizeMB: stamped + 1000 } });

        expect((await getMountQuotaState(ctx.alice.user.id, mountId)).max).toBe((stamped + 1000) * MB);
    });

    test("a lowered default leaves a user's stamp", async () => {
        await updateServerSettings({ quotas: { defaultMountMaxSizeMB: 10 } });
        const mount = { id: 'default', name: 'Drive', storageType: 'local' as const, isDefault: true, maxSizeMB: 400 };

        expect((await resolveUserQuotas(mount, [], 'user')).mountMax).toBe(400 * MB);
    });

    test('a team drive keeps the cap an admin set, under a higher default', async () => {
        await updateServerSettings({ quotas: { defaultMountMaxSizeMB: 5000 } });
        const mount = { id: 'files', name: 'Files', storageType: 'local' as const, isDefault: false, maxSizeMB: 200 };

        expect((await resolveUserQuotas(mount, [], 'team')).mountMax).toBe(200 * MB);
        expect((await resolveUserQuotas(mount, [], 'user')).mountMax).toBe(5000 * MB);
    });
});
