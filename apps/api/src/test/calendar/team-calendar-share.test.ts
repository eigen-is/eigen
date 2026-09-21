import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type {
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { getServerConfig } from '../../lib/config/server-config';
import { getHome } from '../../lib/home';
import * as relay from '../../lib/home/home-relay';
import { addMember, assertJson, authedRequest, createTeam, findOrFail, getTestContext } from '../setup';

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
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        // Create a team
        const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Calendar Share Team',
                organizationId: orgId,
            }),
        });
        const team = await assertJson<{ id: string }>(teamRes);
        teamId = team.id;

        // Enable calendar for the team (disabled by default)
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendar: { enabled: true } }),
        });

        // Add Bob to the team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.bob.user.id }),
        });

        // Get Alice's default calendar
        const calRes = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
        const calendars = await assertJson<CalendarItem[]>(calRes);
        aliceCalendarId = findOrFail(calendars, (c) => c.isDefault).id;
    });

    test('Alice shares calendar with team, Bob (existing member) sees it', async () => {
        // Alice shares her calendar with the team
        const shareRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    shares: [{ targetId: `team_${teamId}`, permission: 'read' }],
                }),
            },
        );
        expect(shareRes.status).toBe(200);

        // Bob should see Alice's shared calendar in his shared list
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await assertJson<SharedCalendar[]>(sharedRes);
        const found = findOrFail(shared, (s) => s.calendarId === aliceCalendarId);
        expect(found.permission).toBe('read');
    });

    test('Charlie (not yet a member) does not see the shared calendar', async () => {
        const sharedRes = await authedRequest(ctx.charlie.user.sessionToken, `/calendar/${ctx.charlie.user.id}/shared`);
        const shared = await assertJson<SharedCalendar[]>(sharedRes);
        const found = shared.find((s: SharedCalendar) => s.calendarId === aliceCalendarId);
        expect(found).toBeUndefined();
    });

    test('Charlie added to team, sees shared calendar via reconciliation', async () => {
        // Add Charlie to the team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId, userId: ctx.charlie.user.id }),
        });

        // Charlie should now see Alice's shared calendar
        const sharedRes = await authedRequest(ctx.charlie.user.sessionToken, `/calendar/${ctx.charlie.user.id}/shared`);
        const shared = await assertJson<SharedCalendar[]>(sharedRes);
        const found = findOrFail(shared, (s) => s.calendarId === aliceCalendarId);
        expect(found.permission).toBe('read');
    });

    test('Bob can also see events via shared-with-me pull route', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.alice.user.id}/shared-with-me`);
        const results = await assertJson<SharedCalendar[]>(res);
        const found = results.find((r: SharedCalendar) => r.calendarId === aliceCalendarId);
        expect(found).toBeDefined();
    });

    test('non-member cannot list team calendars', async () => {
        // Create a separate team that Charlie is NOT a member of
        const team2Res = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Access Control Team',
                organizationId: orgId,
            }),
        });
        const team2 = await assertJson<{ id: string }>(team2Res);

        // Add only Bob, not Charlie
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: team2.id, userId: ctx.bob.user.id }),
        });

        // Charlie should get 403
        const res = await authedRequest(ctx.charlie.user.sessionToken, `/calendar/team_${team2.id}/calendars`);
        expect(res.status).toBe(403);
    });

    test('team member can list team calendars', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/team_${teamId}/calendars`);
        const calendars = await assertJson<CalendarItem[]>(res);
        expect(calendars.length).toBeGreaterThanOrEqual(1);
    });

    test('team calendar appears in shared list with read permission by default', async () => {
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await assertJson<SharedCalendar[]>(sharedRes);
        const teamCal = findOrFail(shared, (s) => s.ownerUserId === `team_${teamId}`);
        expect(teamCal.permission).toBe('read');
    });

    test('team calendar with write share grants write permission', async () => {
        // Get the team's default calendar ID
        const teamCalRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/team_${teamId}/calendars`);
        const teamCalendars = await assertJson<CalendarItem[]>(teamCalRes);
        const teamCalId = teamCalendars[0].id;

        // Set shares on team calendar to grant write to the team (Alice is org admin)
        await authedRequest(ctx.alice.user.sessionToken, `/calendar/team_${teamId}/calendars/${teamCalId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shares: [{ targetId: `team_${teamId}`, permission: 'write' }],
            }),
        });

        // Bob fetches shared list — team calendar should now have write permission
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await assertJson<SharedCalendar[]>(sharedRes);
        const teamCal = findOrFail(shared, (s) => s.ownerUserId === `team_${teamId}` && s.calendarId === teamCalId);
        expect(teamCal.permission).toBe('write');
    });

    test('team calendar with write permission appears in create event options', async () => {
        // The previous test set write permission on the team calendar.
        // Verify Bob can create an event on it.
        const teamCalRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/team_${teamId}/calendars`);
        const teamCalendars = await assertJson<CalendarItem[]>(teamCalRes);
        const teamCalId = teamCalendars[0].id;

        const now = new Date();
        const createRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/team_${teamId}/calendars/${teamCalId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Bob Team Event',
                    startTime: now,
                    endTime: new Date(now.getTime() + 3600_000),
                    allDay: false,
                }),
            },
        );
        const event = await assertJson<CalendarEvent>(createRes);
        expect(event.title).toBe('Bob Team Event');
    });

    test('disabled team calendar is removed from shared list', async () => {
        // Disable the team calendar (Alice is org admin)
        const settingsRes = await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendar: { enabled: false } }),
        });
        const settingsData = await assertJson<{ calendar?: { enabled: boolean } }>(settingsRes);
        expect(settingsData.calendar?.enabled).toBe(false);

        // Bob's shared list should no longer include the team calendar
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await assertJson<SharedCalendar[]>(sharedRes);
        const teamCal = shared.find((s: SharedCalendar) => s.ownerUserId === `team_${teamId}`);
        expect(teamCal).toBeUndefined();

        // Re-enable
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(teamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendar: { enabled: true } }),
        });

        // Should reappear
        const sharedRes2 = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
        const shared2 = await assertJson<SharedCalendar[]>(sharedRes2);
        const teamCal2 = shared2.find((s: SharedCalendar) => s.ownerUserId === `team_${teamId}`);
        expect(teamCal2).toBeDefined();
    });

    // A relay failure says nothing about the share: only an answer — a team with no calendar — removes.
    test('a relay failure leaves the shared entries alone', async () => {
        const before = await assertJson<SharedCalendar[]>(
            await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`),
        );
        expect(before.find((s) => s.ownerUserId === teamOwnerId(teamId))).toBeDefined();

        const spy = spyOn(relay, 'pullCalendars').mockRejectedValue(new Error('the team home is unreachable'));
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await assertJson<SharedCalendar[]>(sharedRes);
        spy.mockRestore();

        expect(shared.find((s) => s.ownerUserId === teamOwnerId(teamId))).toBeDefined();
    });

    test('team settings require team membership', async () => {
        // Create a team Charlie is not in
        const team3Res = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Settings Team', organizationId: orgId }),
        });
        const team3 = await assertJson<{ id: string }>(team3Res);

        const res = await authedRequest(ctx.charlie.user.sessionToken, `/team/${teamOwnerId(team3.id)}/settings`);
        expect(res.status).toBe(403);
    });

    test('Alice creates event in shared calendar, Bob can read it via shared access', async () => {
        const now = new Date();
        const nowSec = Math.floor(now.getTime() / 1000);
        const createRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Team Shared Event',
                    startTime: now,
                    endTime: new Date(now.getTime() + 3600_000),
                    allDay: false,
                }),
            },
        );
        expect(createRes.status).toBe(200);

        // Bob reads events from Alice's shared calendar
        const eventsRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${nowSec - 86400}/${nowSec + 86400}`,
        );
        const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
        const found = events.find((e: CalendarEventOccurrence) => e.title === 'Team Shared Event');
        expect(found).toBeDefined();
    });
});

describe('Regression: Team calendar permission enforcement', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let orgId: string;
    let permTeamId: string;
    let permTeamCalId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const config = getServerConfig();
        orgId = config!.orgId;

        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });

        // Create a dedicated team for permission tests
        const teamRes = await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/create-team', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Permission Enforcement Team',
                organizationId: orgId,
            }),
        });
        const team = await assertJson<{ id: string }>(teamRes);
        permTeamId = team.id;

        // Enable calendar for the team (disabled by default)
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(permTeamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendar: { enabled: true } }),
        });

        // Add Bob to the team
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/add-team-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamId: permTeamId, userId: ctx.bob.user.id }),
        });

        // Get the team's default calendar
        const teamCalRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/team_${permTeamId}/calendars`);
        const teamCalendars = await assertJson<CalendarItem[]>(teamCalRes);
        permTeamCalId = teamCalendars[0].id;
    });

    test('team calendar defaults to read permission for members', async () => {
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await assertJson<SharedCalendar[]>(sharedRes);
        const teamCal = findOrFail(
            shared,
            (s) => s.ownerUserId === `team_${permTeamId}` && s.calendarId === permTeamCalId,
        );
        expect(teamCal.permission).toBe('read');
    });

    test('Bob with read permission can read events', async () => {
        const nowSec = Math.floor(Date.now() / 1000);
        const eventsRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/team_${permTeamId}/calendars/${permTeamCalId}/event-range/${nowSec - 86400}/${nowSec + 86400}`,
        );
        expect(eventsRes.status).toBe(200);
    });

    test('Bob with read permission cannot create events', async () => {
        const now = new Date();
        const createRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/team_${permTeamId}/calendars/${permTeamCalId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Should Fail',
                    startTime: now,
                    endTime: new Date(now.getTime() + 3600_000),
                    allDay: false,
                }),
            },
        );
        expect(createRes.status).toBe(403);
    });

    test('upgrading to write permission allows event creation', async () => {
        // Set write permission on the team calendar (Alice is org admin)
        await authedRequest(ctx.alice.user.sessionToken, `/calendar/team_${permTeamId}/calendars/${permTeamCalId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shares: [{ targetId: `team_${permTeamId}`, permission: 'write' }],
            }),
        });

        // Bob should now have write permission in shared list
        const sharedRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await assertJson<SharedCalendar[]>(sharedRes);
        const teamCal = findOrFail(
            shared,
            (s) => s.ownerUserId === `team_${permTeamId}` && s.calendarId === permTeamCalId,
        );
        expect(teamCal.permission).toBe('write');

        // Bob can now create events
        const now = new Date();
        const createRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/team_${permTeamId}/calendars/${permTeamCalId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Permitted Event',
                    startTime: now,
                    endTime: new Date(now.getTime() + 3600_000),
                    allDay: false,
                }),
            },
        );
        const event = await assertJson<CalendarEvent>(createRes);
        expect(event.title).toBe('Permitted Event');
    });

    test('downgrading back to read revokes write access', async () => {
        // Set back to read permission (Alice is org admin)
        await authedRequest(ctx.alice.user.sessionToken, `/calendar/team_${permTeamId}/calendars/${permTeamCalId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                shares: [{ targetId: `team_${permTeamId}`, permission: 'read' }],
            }),
        });

        // Bob should be denied event creation again
        const now = new Date();
        const createRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/team_${permTeamId}/calendars/${permTeamCalId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Should Fail Again',
                    startTime: now,
                    endTime: new Date(now.getTime() + 3600_000),
                    allDay: false,
                }),
            },
        );
        expect(createRes.status).toBe(403);
    });
});

describe('Team calendar administration', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let adminTeamId: string;
    let adminTeamCalId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const orgId = getServerConfig()!.orgId;
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        adminTeamId = await createTeam(ctx, orgId, 'Calendar Administration Team');
        await authedRequest(ctx.alice.user.sessionToken, `/team/${teamOwnerId(adminTeamId)}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ calendar: { enabled: true } }),
        });
        await addMember(ctx, adminTeamId, ctx.bob.user.id);
        const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${teamOwnerId(adminTeamId)}/calendars`);
        adminTeamCalId = (await assertJson<CalendarItem[]>(res))[0].id;
    });

    test('a plain member cannot grant himself write on the team calendar', async () => {
        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${teamOwnerId(adminTeamId)}/calendars/${adminTeamCalId}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shares: [{ targetId: teamOwnerId(adminTeamId), permission: 'write' }] }),
            },
        );
        expect(res.status).toBe(403);

        const sharedRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
        const shared = await assertJson<SharedCalendar[]>(sharedRes);
        const teamCal = findOrFail(shared, (s) => s.calendarId === adminTeamCalId);
        expect(teamCal.permission).toBe('read');
    });

    test('a plain member cannot create a calendar in the team home', async () => {
        const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${teamOwnerId(adminTeamId)}/calendars`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Bob Sneaks In', color: '#ff0000' }),
        });
        expect(res.status).toBe(403);
    });

    test('a plain member cannot delete a team calendar', async () => {
        const teamCal = await getHome(teamOwnerId(adminTeamId));
        const extra = await teamCal.calendar.createCalendar({ name: 'Team Retros', color: '#34a853' });

        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${teamOwnerId(adminTeamId)}/calendars/${extra.id}`,
            { method: 'DELETE' },
        );
        expect(res.status).toBe(403);

        const listRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${teamOwnerId(adminTeamId)}/calendars`,
        );
        const calendars = await assertJson<CalendarItem[]>(listRes);
        expect(calendars.some((c) => c.id === extra.id)).toBe(true);
    });

    // The Admin app's team detail: the list is what it reads the default calendar and its shares off.
    test('an org admin who is not a team member reads the team calendar list and sets its shares', async () => {
        const listRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${teamOwnerId(adminTeamId)}/calendars`,
        );
        const teamDefault = findOrFail(await assertJson<CalendarItem[]>(listRes), (c) => c.isDefault);

        const shareRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${teamOwnerId(adminTeamId)}/calendars/${teamDefault.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shares: [{ targetId: teamOwnerId(adminTeamId), permission: 'write' }] }),
            },
        );
        const updated = await assertJson<CalendarItem>(shareRes);
        expect(updated.shares).toEqual([{ targetId: teamOwnerId(adminTeamId), permission: 'write' }]);

        // The events of that calendar stay on membership plus share: administering is not reading.
        const from = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000);
        const to = Math.floor(Date.parse('2026-02-01T00:00:00Z') / 1000);
        const eventsRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${teamOwnerId(adminTeamId)}/event-range/${from}/${to}`,
        );
        expect(eventsRes.status).toBe(403);
    });

    test('an org admin administers the team calendar', async () => {
        const createRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${teamOwnerId(adminTeamId)}/calendars`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Team Offsites', color: '#4285f4' }),
            },
        );
        const created = await assertJson<CalendarItem>(createRes);

        const shareRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${teamOwnerId(adminTeamId)}/calendars/${created.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shares: [{ targetId: teamOwnerId(adminTeamId), permission: 'write' }] }),
            },
        );
        expect(shareRes.status).toBe(200);

        const deleteRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${teamOwnerId(adminTeamId)}/calendars/${created.id}`,
            { method: 'DELETE' },
        );
        expect(deleteRes.status).toBe(200);
    });
});
