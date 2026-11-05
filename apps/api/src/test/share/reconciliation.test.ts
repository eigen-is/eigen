import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { getServerConfig } from '../../lib/config/server-config';
import { evictHome, getHome } from '../../lib/home/get-home';
import * as relay from '../../lib/home/home-relay';
import { reconcileShares } from '../../lib/share';
import { addRegistryEntry } from '../../lib/share/registry';
import { getUserById } from '../../lib/user';
import { addMember, assertJson, authedRequest, createTeam, createTestUser, findOrFail, getTestContext } from '../setup';

describe('share reconciliation', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    const spies: { mockRestore(): void }[] = [];

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
    });

    async function aliceCalendar(name: string, shares: { targetId: string; permission: string }[]) {
        const created = await assertJson<CalendarItem>(
            await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            }),
        );
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${created.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shares }),
            },
        );
        expect(res.status).toBe(200);
        return created;
    }

    async function storedPermission(userId: string, calendarId: string) {
        const home = await getHome(userId);
        const entries = await home.calendar.getSharedCalendars();
        return findOrFail(entries, (entry) => entry.calendarId === calendarId).permission;
    }

    test('a new account stores the strongest permission, its teams included', async () => {
        const defaultTeamId = getServerConfig()?.defaultTeamId;
        if (!defaultTeamId) throw new Error('the test server has no default team');
        const email = `recon-perm-${crypto.randomUUID()}@test.eigen.is`;
        const calendar = await aliceCalendar('Read by address, written by team', [
            { targetId: email, permission: 'read' },
            { targetId: teamOwnerId(defaultTeamId), permission: 'write' },
        ]);

        const created = await createTestUser(email, 'testpassword123', 'Newcomer');

        expect(await storedPermission(created.id, calendar.id)).toBe('write');
    });

    test('an invitation sent before the account existed reaches it', async () => {
        const email = `recon-invite-${crypto.randomUUID()}@test.eigen.is`;
        const title = `Pending invite ${crypto.randomUUID()}`;
        const calendars = await assertJson<CalendarItem[]>(
            await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`),
        );
        const calendarId = findOrFail(calendars, (c) => c.isDefault).id;
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${calendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    startTime: new Date(Date.now() + 3600_000),
                    endTime: new Date(Date.now() + 7200_000),
                    allDay: false,
                    data: { attendees: [{ email, status: 'pending', role: 'required' }] },
                }),
            },
        );
        expect(res.status).toBe(200);

        const created = await createTestUser(email, 'testpassword123', 'Invitee');

        const from = Math.floor(Date.now() / 1000) - 86400;
        const to = Math.floor(Date.now() / 1000) + 86400 * 7;
        const events = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(created.sessionToken, `/calendar/${created.id}/event-range/${from}/${to}`),
        );
        expect(events.some((event) => event.title === title)).toBe(true);
    });

    // An invitation names an address, so a team join has none to pull, and a pull would re-add one the member removed.
    test('joining a team delivers its shares and pulls no invitations', async () => {
        const orgId = getServerConfig()?.orgId;
        if (!orgId) throw new Error('the test server has no org');
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        const teamId = await createTeam(ctx, orgId, `Recon join ${crypto.randomUUID()}`);
        const calendar = await aliceCalendar('Shared with a team', [
            { targetId: teamOwnerId(teamId), permission: 'read' },
        ]);
        const invitations = spyOn(relay, 'pullPendingInvitations');
        spies.push(invitations);

        await addMember(ctx, teamId, ctx.bob.user.id);

        expect(await storedPermission(ctx.bob.user.id, calendar.id)).toBe('read');
        expect(invitations).not.toHaveBeenCalled();
    });

    // Reconciliation waits on pulls from other homes, and the newcomer's home may close meanwhile.
    test('a delivery reopens a home that closed during a slow pull', async () => {
        const stamp = Date.now();
        const owner = await createTestUser(`recon-owner-${stamp}@test.eigen.is`, 'testpassword123', 'Owner');
        const created = await createTestUser(`recon-new-${stamp}@test.eigen.is`, 'testpassword123', 'Newcomer');
        const user = await getUserById(created.id);
        if (!user) throw new Error('newcomer missing');
        await addRegistryEntry(owner.id, user.email);
        await getHome(user.id);

        let openGate: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            openGate = resolve;
        });
        let reached: () => void = () => {};
        const pulling = new Promise<void>((resolve) => {
            reached = resolve;
        });
        const share = { calendarId: `gated-${stamp}`, name: 'Gated', color: '#000000', permission: 'read' as const };
        spies.push(
            spyOn(relay, 'pullCalendarShares').mockImplementation(async () => {
                reached();
                await gate;
                return [share];
            }),
            spyOn(relay, 'pullPendingInvitations').mockResolvedValue([]),
            spyOn(relay, 'pullSharedPaths').mockResolvedValue([]),
        );

        const running = reconcileShares(user, user.email);
        await pulling;
        await evictHome(user.id);
        openGate();
        await running;

        expect(await storedPermission(user.id, share.calendarId)).toBe('read');
    });
});
