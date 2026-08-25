import { beforeAll, describe, expect, test } from 'bun:test';
import { getServerConfig } from '../../lib/config/server-config';
import { assertJson, authedRequest, findOrFail, getTestContext, type TestContext } from '../setup';

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
        expect(typeof data!.mailAndContacts.used).toBe('number');
        expect(typeof data!.mailAndContacts.max).toBe('number');
        expect(typeof data!.drive.default.used).toBe('number');
        expect(typeof data!.drive.default.max).toBe('number');
        expect(typeof data!.total.used).toBe('number');
        expect(typeof data!.total.max).toBe('number');
        expect(data!.total.max).toBeGreaterThan(0);
    });

    test('total.used = mailAndContacts.used + drive.default.used', async () => {
        const { data } = await ctx.alice.api.home({ ownerId: ctx.alice.user.id }).size.get();

        expect(data!.total.used).toBe(data!.mailAndContacts.used + data!.drive.default.used);
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
});
