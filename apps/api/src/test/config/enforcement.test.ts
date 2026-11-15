import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import { getMountQuotaState } from '../../lib/config/enforcement';
import { resolveHomeDataMax, resolveUserQuotas } from '../../lib/config/quota';
import { getPublicConfig, getServerConfig } from '../../lib/config/server-config';
import { getServerSettings, updateServerSettings } from '../../lib/config/server-settings';
import { clearHomeRestoring, getHome, markHomeRestoring } from '../../lib/home/get-home';
import { getFromHomes } from '../../lib/home/home-relay';
import * as teamModule from '../../lib/team/team';
import { getMemberships } from '../../lib/user';
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

// A team that does not answer adds no override, so a write can be refused at the lower limit but never fails whole.
describe('a team that does not answer adds no override', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let raising: string;
    let restoring: string;
    const MB = 1024 * 1024;

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        raising = await createTeam(ctx, orgId, 'Raising Team');
        restoring = await createTeam(ctx, orgId, 'Restoring Team');
        for (const teamId of [raising, restoring]) await addMember(ctx, teamId, ctx.charlie.user.id);
        await setHomeDataOverride(raising, getServerSettings().quotas.homeDataMaxMB + 1000);
    });

    afterEach(() => {
        mock.restore();
    });

    afterAll(async () => {
        await setHomeDataOverride(raising, null);
    });

    function setHomeDataOverride(teamId: string, homeDataMaxMB: number | null): Promise<Response> {
        return authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberOverrides: { homeDataMaxMB } }),
        });
    }

    async function homeDataMaxWhileRestoring(teamId: string): Promise<number> {
        markHomeRestoring(teamOwnerId(teamId));
        try {
            return await resolveHomeDataMax((await getMemberships(ctx.charlie.user.id)).teamIds);
        } finally {
            clearHomeRestoring(teamOwnerId(teamId));
        }
    }

    test('the teams that answer still raise the limit, and the one that does not is logged', async () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {});

        expect(await homeDataMaxWhileRestoring(restoring)).toBe((getServerSettings().quotas.homeDataMaxMB + 1000) * MB);
        expect(errors).toHaveBeenCalledWith(
            `home-relay: team:quota-overrides from ${teamOwnerId(restoring)} failed:`,
            expect.anything(),
        );
    });

    test('with the raising team not answering, the server default applies', async () => {
        spyOn(console, 'error').mockImplementation(() => {});

        expect(await homeDataMaxWhileRestoring(raising)).toBe(getServerSettings().quotas.homeDataMaxMB * MB);
    });
});

describe('a user in two teams that both raise a limit gets the higher', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let higher: string;
    let lower: string;
    const MB = 1024 * 1024;

    function setOverrides(teamId: string, raise: number | null): Promise<Response> {
        const { homeDataMaxMB, defaultMountMaxSizeMB } = getServerSettings().quotas;
        return authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                memberOverrides: {
                    homeDataMaxMB: raise === null ? null : homeDataMaxMB + raise,
                    defaultMountMaxSizeMB: raise === null ? null : defaultMountMaxSizeMB + raise,
                },
            }),
        });
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getPublicConfig().orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        higher = await createTeam(ctx, orgId, 'Higher Override Team');
        lower = await createTeam(ctx, orgId, 'Lower Override Team');
        for (const teamId of [higher, lower]) await addMember(ctx, teamId, ctx.charlie.user.id);
        await setOverrides(higher, 2000);
        await setOverrides(lower, 1000);
    });

    afterAll(async () => {
        for (const teamId of [higher, lower]) await setOverrides(teamId, null);
    });

    test('for the home-data budget, whichever team comes first', async () => {
        const expected = (getServerSettings().quotas.homeDataMaxMB + 2000) * MB;

        expect(await resolveHomeDataMax([higher, lower])).toBe(expected);
        expect(await resolveHomeDataMax([lower, higher])).toBe(expected);
    });

    test('asks a loaded team for its overrides without looking the team up', async () => {
        for (const teamId of [higher, lower]) await getHome(teamOwnerId(teamId));
        const lookups = spyOn(teamModule, 'getTeam');
        let looked: string[];
        try {
            await resolveHomeDataMax([higher, lower]);
        } finally {
            looked = lookups.mock.calls.map(([teamId]) => teamId);
            lookups.mockRestore();
        }

        expect(looked).toEqual([]);
    });

    test("for a drive's cap, whichever team comes first", async () => {
        const expected = (getServerSettings().quotas.defaultMountMaxSizeMB + 2000) * MB;
        const mount = { id: 'default', name: 'Drive', storageType: 'local' as const, isDefault: true, maxSizeMB: 10 };

        expect((await resolveUserQuotas(mount, [higher, lower], 'user')).mountMax).toBe(expected);
        expect((await resolveUserQuotas(mount, [lower, higher], 'user')).mountMax).toBe(expected);
    });
});

// Every owner can be asked for overrides, and only a team has any.
test("a home that is not a team's raises nothing", async () => {
    const { charlie } = await getTestContext();
    const answers = await getFromHomes([charlie.user.id], 'team:quota-overrides', null);

    expect(answers.get(charlie.user.id)).toEqual({});
});
