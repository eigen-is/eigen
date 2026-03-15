import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext} from './setup';
import {getServerConfig} from '../lib/config/server-config';

describe('Team Calendar Share (push to existing members)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let orgId: string;
    let teamId: string;
    let aliceCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        orgId = config!.orgId;

        // Set active org for Alice
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/set-active', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({organizationId: orgId}),
            });

        // Create a team
        const teamRes = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    name: 'Calendar Share Team',
                    organizationId: orgId,
                }),
            });
        const team = await teamRes.json() as any;
        teamId = team.id;

        // Add Bob to the team
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.bob.user.id}),
            });

        // Get Alice's default calendar
        const calRes = await authedRequest(ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars`);
        const calendars = await calRes.json() as any[];
        aliceCalendarId = calendars.find((c: any) => c.isDefault).id;
    });

    test('Alice shares calendar with team, Bob (existing member) sees it', async () => {
        // Alice shares her calendar with the team
        const shareRes = await authedRequest(ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    shares: [{targetId: `team_${teamId}`, permission: 'read'}],
                }),
            });
        expect(shareRes.status).toBe(200);

        // Bob should see Alice's shared calendar in his shared list
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/shared`);
        expect(sharedRes.status).toBe(200);
        const shared = await sharedRes.json() as any[];
        const found = shared.find((s: any) => s.calendarId === aliceCalendarId);
        expect(found).toBeDefined();
        expect(found.permission).toBe('read');
    });

    test('Charlie (not yet a member) does not see the shared calendar', async () => {
        const sharedRes = await authedRequest(ctx.charlie.user.sessionToken,
            `/calendar/${ctx.charlie.user.id}/shared`);
        const shared = await sharedRes.json() as any[];
        const found = shared.find((s: any) => s.calendarId === aliceCalendarId);
        expect(found).toBeUndefined();
    });

    test('Charlie added to team, sees shared calendar via reconciliation', async () => {
        // Add Charlie to the team
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId, userId: ctx.charlie.user.id}),
            });

        // Charlie should now see Alice's shared calendar
        const sharedRes = await authedRequest(ctx.charlie.user.sessionToken,
            `/calendar/${ctx.charlie.user.id}/shared`);
        const shared = await sharedRes.json() as any[];
        const found = shared.find((s: any) => s.calendarId === aliceCalendarId);
        expect(found).toBeDefined();
        expect(found.permission).toBe('read');
    });

    test('Bob can also see events via shared-with-me pull route', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/shared-with-me`);
        expect(res.status).toBe(200);
        const results = await res.json() as any[];
        const found = results.find((r: any) => r.calendarId === aliceCalendarId);
        expect(found).toBeDefined();
    });

    test('non-member cannot list team calendars', async () => {
        // Create a separate team that Charlie is NOT a member of
        const team2Res = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    name: 'Access Control Team',
                    organizationId: orgId,
                }),
            });
        const team2 = await team2Res.json() as any;

        // Add only Bob, not Charlie
        await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/add-team-member', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({teamId: team2.id, userId: ctx.bob.user.id}),
            });

        // Charlie should get 403
        const res = await authedRequest(ctx.charlie.user.sessionToken,
            `/calendar/team_${team2.id}/calendars`);
        expect(res.status).toBe(403);
    });

    test('team member can list team calendars', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/team_${teamId}/calendars`);
        expect(res.status).toBe(200);
        const calendars = await res.json() as any[];
        expect(calendars.length).toBeGreaterThanOrEqual(1);
    });

    test('team calendar appears in shared list with read permission by default', async () => {
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await sharedRes.json() as any[];
        const teamCal = shared.find((s: any) => s.ownerUserId === `team_${teamId}`);
        expect(teamCal).toBeDefined();
        expect(teamCal.permission).toBe('read');
    });

    test('team calendar with write share grants write permission', async () => {
        // Get the team's default calendar ID
        const teamCalRes = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/team_${teamId}/calendars`);
        const teamCalendars = await teamCalRes.json() as any[];
        const teamCalId = teamCalendars[0].id;

        // Set shares on team calendar to grant write to the team
        await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/team_${teamId}/calendars/${teamCalId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    shares: [{targetId: `team_${teamId}`, permission: 'write'}],
                }),
            });

        // Bob fetches shared list — team calendar should now have write permission
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await sharedRes.json() as any[];
        const teamCal = shared.find((s: any) => s.ownerUserId === `team_${teamId}` && s.calendarId === teamCalId);
        expect(teamCal).toBeDefined();
        expect(teamCal.permission).toBe('write');
    });

    test('team calendar with write permission appears in create event options', async () => {
        // The previous test set write permission on the team calendar.
        // Verify Bob can create an event on it.
        const teamCalRes = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/team_${teamId}/calendars`);
        const teamCalendars = await teamCalRes.json() as any[];
        const teamCalId = teamCalendars[0].id;

        const now = Math.floor(Date.now() / 1000);
        const createRes = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/team_${teamId}/calendars/${teamCalId}/events`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    title: 'Bob Team Event',
                    startTime: now,
                    endTime: now + 3600,
                    allDay: false,
                }),
            });
        expect(createRes.status).toBe(200);
        const event = await createRes.json() as any;
        expect(event.title).toBe('Bob Team Event');
    });

    test('disabled team calendar is removed from shared list', async () => {
        // Disable the team calendar (Alice is org admin)
        const settingsRes = await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({calendar: {enabled: false}}),
            });
        expect(settingsRes.status).toBe(200);
        const settingsData = await settingsRes.json() as any;
        expect(settingsData.calendar?.enabled).toBe(false);

        // Bob's shared list should no longer include the team calendar
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await sharedRes.json() as any[];
        const teamCal = shared.find((s: any) => s.ownerUserId === `team_${teamId}`);
        expect(teamCal).toBeUndefined();

        // Re-enable
        await authedRequest(ctx.alice.user.sessionToken,
            `/team/${teamId}/settings`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({calendar: {enabled: true}}),
            });

        // Should reappear
        const sharedRes2 = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/shared`);
        const shared2 = await sharedRes2.json() as any[];
        const teamCal2 = shared2.find((s: any) => s.ownerUserId === `team_${teamId}`);
        expect(teamCal2).toBeDefined();
    });

    test('team settings require team membership', async () => {
        // Create a team Charlie is not in
        const team3Res = await authedRequest(ctx.alice.user.sessionToken,
            '/auth/organization/create-team', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: 'Settings Team', organizationId: orgId}),
            });
        const team3 = await team3Res.json() as any;

        const res = await authedRequest(ctx.charlie.user.sessionToken,
            `/team/${team3.id}/settings`);
        expect(res.status).toBe(403);
    });

    test('Alice creates event in shared calendar, Bob can read it via shared access', async () => {
        const now = Math.floor(Date.now() / 1000);
        const createRes = await authedRequest(ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    title: 'Team Shared Event',
                    startTime: now,
                    endTime: now + 3600,
                    allDay: false,
                }),
            });
        expect(createRes.status).toBe(200);

        // Bob reads events from Alice's shared calendar
        const eventsRes = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${now - 86400}/${now + 86400}`);
        expect(eventsRes.status).toBe(200);
        const events = await eventsRes.json() as any[];
        const found = events.find((e: any) => e.title === 'Team Shared Event');
        expect(found).toBeDefined();
    });
});
