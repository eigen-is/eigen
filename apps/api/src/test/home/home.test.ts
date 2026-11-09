import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { orgOwnerId, teamOwnerId } from '@workspace/lib/types/owner';
import { getUserHomePath } from '../../lib/config/paths';
import { getPublicConfig, getServerConfig } from '../../lib/config/server-config';
import { ApiError } from '../../lib/core';
import { evictHome, getHome } from '../../lib/home/get-home';
import type { HomeSettings } from '../../lib/home/home';
import * as homeRelay from '../../lib/home/home-relay';
import type { TestContext } from '../setup';
import {
    addMember,
    addTeamMount,
    assertJson,
    authedRequest,
    createTeam,
    createTestGuest,
    createTestUser,
    findOrFail,
    getTestContext,
} from '../setup';

type MyTeam = {
    id: string;
    name: string;
    members: { email: string; name: string }[];
    mounts: { id: string; name: string }[];
    calendars: { id: string; name: string; color: string }[];
};

describe('Home', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('get home size returns valid structure', async () => {
        const { data, error } = await ctx.alice.api.home({ ownerId: ctx.alice.user.id }).size.get();

        expect(error).toBeNull();
        expect(data).toBeDefined();
        expect(typeof data!.homeData.used).toBe('number');
        expect(typeof data!.homeData.max).toBe('number');
        expect(typeof data!.drive.default.used).toBe('number');
        expect(typeof data!.drive.default.max).toBe('number');
        expect(typeof data!.total.used).toBe('number');
        expect(typeof data!.total.max).toBe('number');
        expect(data!.total.max).toBeGreaterThan(0);
    });

    test('total.used = homeData.used + drive.default.used', async () => {
        const { data } = await ctx.alice.api.home({ ownerId: ctx.alice.user.id }).size.get();

        expect(data!.total.used).toBe(data!.homeData.used + data!.drive.default.used);
    });

    test('Bob has his own separate home', async () => {
        const { data, error } = await ctx.bob.api.home({ ownerId: ctx.bob.user.id }).size.get();

        expect(error).toBeNull();
        expect(data).toBeDefined();
        expect(typeof data!.total.used).toBe('number');
    });

    test('ownerId spoofing on size endpoint is rejected with 403', async () => {
        const spoofed = await authedRequest(ctx.bob.user.sessionToken, `/home/${ctx.alice.user.id}/size`);
        expect(spoofed.status).toBe(403);
    });

    test('zip endpoint returns 404 (not yet implemented)', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/home/${ctx.alice.user.id}/zip`);

        expect(res.status).toBe(404);
    });
});

describe('home: my-teams', () => {
    let ctx: TestContext;
    let teamId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;

        // Set active org
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        // Create a team
        const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Test Team', organizationId: orgId }),
        });
        const teamData = await assertJson<{ id: string }>(teamRes);
        teamId = teamData.id;

        // Add alice and bob to team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.alice.user.id }),
        });
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
        });
    });

    test('returns teams with members for authenticated user', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, `/home/${ctx.alice.user.id}/my-teams`);
        const teams = await assertJson<MyTeam[]>(res);

        const team = findOrFail(teams, (t) => t.id === teamId, 'Test team not found');
        expect(team.name).toBe('Test Team');
        const memberEmails = team.members.map((m) => m.email);
        expect(memberEmails).toContain(ctx.alice.user.email);
        expect(memberEmails).toContain(ctx.bob.user.email);
        expect(team.members[0]).toHaveProperty('name');
        expect(Array.isArray(team.mounts)).toBe(true);
        expect(Array.isArray(team.calendars)).toBe(true);
    });

    test('does not return teams for non-member', async () => {
        const res = await authedRequest(ctx.charlie.user.sessionToken, `/home/${ctx.charlie.user.id}/my-teams`);
        const teams = await assertJson<MyTeam[]>(res);
        const team = teams.find((t) => t.id === teamId);
        expect(team).toBeUndefined();
    });

    test('rejects request for another user', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/home/${ctx.alice.user.id}/my-teams`);
        expect(res.status).toBe(403);
    });

    afterEach(() => mock.restore());

    function myTeams(): Promise<MyTeam[]> {
        return authedRequest(ctx.alice.user.sessionToken, `/home/${ctx.alice.user.id}/my-teams`).then((res) =>
            assertJson<MyTeam[]>(res),
        );
    }

    test('logs a failed mount read and still lists every team, the others with their mounts', async () => {
        const orgId = getPublicConfig().orgId;
        const liveTeam = await createTeam(ctx, orgId, `Live ${crypto.randomUUID()}`);
        const brokenTeam = await createTeam(ctx, orgId, `Broken ${crypto.randomUUID()}`);
        for (const id of [liveTeam, brokenTeam]) {
            await addMember(ctx, id, ctx.alice.user.id);
            await addTeamMount(ctx, id, 'Drive');
        }

        const pullTeamMounts = homeRelay.pullTeamMounts;
        spyOn(homeRelay, 'pullTeamMounts').mockImplementation(async (ownerId) => {
            if (ownerId === teamOwnerId(brokenTeam)) throw new Error('metadata.db is unreadable');
            return pullTeamMounts(ownerId);
        });
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        const teams = await myTeams();
        expect(errors).toHaveBeenCalledWith(expect.stringContaining(brokenTeam), expect.anything());
        expect(findOrFail(teams, (t) => t.id === brokenTeam).mounts).toEqual([]);
        expect(findOrFail(teams, (t) => t.id === liveTeam).mounts.map((m) => m.name)).toEqual(['Drive']);
    });

    test('logs nothing for a team with its calendar off, the default', async () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {});
        const teams = await myTeams();
        expect(findOrFail(teams, (t) => t.id === teamId).calendars).toEqual([]);
        expect(errors).not.toHaveBeenCalled();
    });
});

describe('Home init', () => {
    test("sweeps a settings file's staged copy a crash left a day ago, and keeps a young one", async () => {
        const user = await createTestUser(`sweep-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Sweep');
        await getHome(user.id);
        await evictHome(user.id);
        const homeDir = getUserHomePath(user.id);
        const stale = join(homeDir, `.settings.json.tmp-${crypto.randomUUID()}`);
        const young = join(homeDir, `.settings.json.tmp-${crypto.randomUUID()}`);
        writeFileSync(stale, '{}');
        writeFileSync(young, '{}');
        const dayAndAnHourAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
        utimesSync(stale, dayAndAnHourAgo, dayAndAnHourAgo);

        await getHome(user.id);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(young)).toBe(true);
    });

    test('a fresh user home saves its default mount in settings.json and opens it', async () => {
        const user = await createTestUser(`fresh-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Fresh');
        const home = await getHome(user.id);

        const saved: HomeSettings = JSON.parse(readFileSync(join(getUserHomePath(user.id), 'settings.json'), 'utf8'));
        expect(saved.mounts?.['default']?.enabled).toBe(true);
        expect(home.drive.getMountConfig('default').isDefault).toBe(true);
    });

    test('a default mount switched off in settings.json stays off', async () => {
        const user = await createTestUser(`mount-off-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Off');
        const home = await getHome(user.id);
        await home.settings.set({ mounts: { default: { enabled: false } } });
        await evictHome(user.id);

        const reopened = await getHome(user.id);
        expect(reopened.drive.getMounts().map((mount) => mount.config.id)).not.toContain('default');
    });

    test('a user home whose default mount is off still answers its size, files included', async () => {
        const user = await createTestUser(`size-off-${crypto.randomUUID()}@test.eigen.is`, 'testpassword123', 'Size');
        const home = await getHome(user.id);
        const root = await home.drive.getRootFolder('default');
        if (!root) throw new Error('The default mount has no root folder');
        await home.drive.createFileFromData('default', root.id, 'note.txt', 'text/plain', Buffer.from('some bytes'));
        const before = await home.size();
        expect(before.drive.default.used).toBeGreaterThan(0);
        await home.settings.set({ mounts: { default: { enabled: false } } });
        await evictHome(user.id);

        const reopened = await getHome(user.id);
        expect(await reopened.size()).toEqual(before);
    });
});

function thrownBy(read: () => unknown): unknown {
    try {
        read();
    } catch (err) {
        return err;
    }
    return undefined;
}

describe('Home parts', () => {
    let ctx: TestContext;
    let orgId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        if (!config) throw new Error('No server config');
        orgId = config.orgId;
    });

    test('a part the home lacks answers 404', async () => {
        const team = await getHome(teamOwnerId(await createTeam(ctx, orgId, 'Parts Team')));
        const org = await getHome(orgOwnerId(orgId));

        for (const err of [thrownBy(() => team.notifications), thrownBy(() => org.drive)]) {
            expect(err).toBeInstanceOf(ApiError);
            expect(err).toMatchObject({ status: 404 });
        }
    });

    test('notify reaches user and guest homes, and a team home drops it', async () => {
        const user = await getHome(ctx.alice.user.id);
        const guest = await getHome((await createTestGuest('Parts Guest')).id);
        const team = await getHome(teamOwnerId(await createTeam(ctx, orgId, 'Parts Team Two')));

        user.notify({ type: 'share', title: 'Notify user' });
        guest.notify({ type: 'share', title: 'Notify guest' });
        expect(() => team.notify({ type: 'share', title: 'Notify team' })).not.toThrow();

        expect(user.notifications.list().map((n) => n.title)).toContain('Notify user');
        expect(guest.notifications.list().map((n) => n.title)).toContain('Notify guest');
    });
});
