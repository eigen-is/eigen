import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types';
import { teamOwnerId } from '@workspace/lib/types';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { requestOtp, verifyOtpAndSignIn } from '../../lib/auth/guest-auth';
import { getServerConfig } from '../../lib/config/server-config';
import { evictHome, getHome } from '../../lib/home/get-home';
import * as relay from '../../lib/home/home-relay';
import * as mailer from '../../lib/mailer/mailer';
import { reconcileShares } from '../../lib/share';
import { addRegistryEntry } from '../../lib/share/registry';
import { getUserByEmail, getUserById } from '../../lib/user';
import { vcal } from '../ics-test-helpers';
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

    // The newcomer's copy is what an Eigen guest invited today holds: the series with its moved and cancelled dates, and
    // an occurrence they alone were invited to as that one occurrence of its series.
    test('a newcomer gets each series with its exceptions, and an occurrence invitation as that occurrence', async () => {
        const email = `recon-series-${crypto.randomUUID()}@test.eigen.is`;
        const guest = { email, status: 'pending', role: 'required' };
        const calendars = await assertJson<CalendarItem[]>(
            await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`),
        );
        const calendarId = findOrFail(calendars, (c) => c.isDefault).id;
        const post = async (body: Record<string, unknown>) =>
            assertJson<CalendarEvent>(
                await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${calendarId}/events`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ allDay: false, rrule: null, timezone: 'Europe/Amsterdam', ...body }),
                    },
                ),
            );
        const weekly = (title: string, attendees: object[]) =>
            post({
                title,
                startTime: '2027-03-02T09:00:00Z',
                endTime: '2027-03-02T10:00:00Z',
                rrule: 'FREQ=WEEKLY;COUNT=4',
                data: { attendees },
            });
        const occurrence = (series: CalendarEvent, date: string, body: Record<string, unknown>) =>
            post({
                title: series.title,
                startTime: `${date}T09:00:00Z`,
                endTime: `${date}T10:00:00Z`,
                parentEventId: series.id,
                recurrenceDate: date,
                ...body,
            });
        const series = await weekly('Recon series', [guest]);
        await occurrence(series, '2027-03-09', {
            title: 'Recon moved',
            startTime: '2027-03-09T11:00:00Z',
            endTime: '2027-03-09T12:00:00Z',
            data: { attendees: [guest] },
        });
        await occurrence(series, '2027-03-16', { status: 'cancelled' });
        const other = await weekly('Recon other', []);
        await occurrence(other, '2027-03-23', { title: 'Recon only this one', data: { attendees: [guest] } });

        const created = await createTestUser(email, 'testpassword123', 'Newcomer');

        const home = await getHome(created.id);
        const copy = await home.calendar.getEventsByUid(series.uid);
        expect(findOrFail(copy, (e) => !e.parentEventId).title).toBe('Recon series');
        expect(findOrFail(copy, (e) => e.recurrenceDate === '2027-03-09').title).toBe('Recon moved');
        expect(findOrFail(copy, (e) => e.recurrenceDate === '2027-03-16').status).toBe('cancelled');
        expect(copy).toHaveLength(3);
        const [lone, ...rest] = await home.calendar.getEventsByUid(other.uid);
        expect(rest).toHaveLength(0);
        expect(lone).toMatchObject({ title: 'Recon only this one', recurrenceDate: '2027-03-23', parentEventId: null });
        expect(lone.data?.organizerEventId).toBe(other.id);
    });

    test("a newcomer gets nothing from an event somebody else organizes, synced in by the owner's client", async () => {
        const email = `recon-foreign-${crypto.randomUUID()}@test.eigen.is`;
        const uid = `foreign-${crypto.randomUUID()}@external.com`;
        const calendar = (await getHome(ctx.alice.user.id)).calendar;
        const calendarId = findOrFail(await calendar.getCalendars(), (c) => c.isDefault).id;
        const ics = vcal([
            'BEGIN:VEVENT',
            `UID:${uid}`,
            'SUMMARY:Somebody else organizes',
            'DTSTART:20270302T090000Z',
            'DTEND:20270302T100000Z',
            'ORGANIZER:mailto:outside@external.com',
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ctx.alice.user.email}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${email}`,
            'DTSTAMP:20270101T000000Z',
            'END:VEVENT',
        ]);
        const put = await calendar.putResource(calendarId, `${uid}.ics`, ics, { ifMatch: null, ifNoneMatch: null });
        expect(put.ok).toBe(true);

        expect((await calendar.pendingInvitations(email)).map((request) => request.events[0].uid)).not.toContain(uid);
    });

    // The guests who held a cancelled series had their copies purged, so a newcomer is owed nothing of it either.
    test('a newcomer gets nothing from a cancelled series, as a guest of it or of one of its dates', async () => {
        const seriesGuest = `recon-cancelled-${crypto.randomUUID()}@test.eigen.is`;
        const dateGuest = `recon-cancelled-date-${crypto.randomUUID()}@test.eigen.is`;
        const calendar = (await getHome(ctx.alice.user.id)).calendar;
        const calendarId = findOrFail(await calendar.getCalendars(), (c) => c.isDefault).id;
        const guest = (email: string) => ({ email, status: 'pending' as const, role: 'required' as const });
        const series = await calendar.createEvent(calendarId, {
            title: 'Recon cancelled series',
            startTime: new Date('2027-04-06T09:00:00Z'),
            endTime: new Date('2027-04-06T10:00:00Z'),
            allDay: false,
            rrule: 'FREQ=WEEKLY;COUNT=4',
            data: { attendees: [guest(seriesGuest)] },
        });
        await calendar.createEvent(calendarId, {
            title: 'Recon cancelled date',
            startTime: new Date('2027-04-13T09:00:00Z'),
            endTime: new Date('2027-04-13T10:00:00Z'),
            allDay: false,
            parentEventId: series.id,
            recurrenceDate: '2027-04-13',
            data: { attendees: [guest(dateGuest)] },
        });
        await calendar.updateEvent(calendarId, series.id, { status: 'cancelled' });

        for (const email of [seriesGuest, dateGuest]) {
            const owed = (await calendar.pendingInvitations(email)).map((request) => request.events[0].uid);
            expect(owed).not.toContain(series.uid);
        }
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

    // A guest's home has no calendar, so a calendar pull would scan the owner's calendar for nothing.
    test('a guest sign-in delivers shared paths and pulls no calendars', async () => {
        const email = `recon-guest-${crypto.randomUUID()}@external.com`;
        await aliceCalendar('Shared with a guest', [{ targetId: email, permission: 'read' }]);
        const root = await assertJson<DrivePath>(
            await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/default/root`),
        );
        const folderName = `recon-guest-${crypto.randomUUID()}`;
        const folder = await assertJson<DrivePath>(
            await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/default/folder/${root.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderName }),
            }),
        );
        const acl = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/default/path/${folder.id}/acl`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ add: [{ id: email, read: true, write: false }] }),
            },
        );
        expect(acl.status).toBe(200);
        const sent = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        const calendarShares = spyOn(relay, 'pullCalendarShares');
        const invitations = spyOn(relay, 'pullPendingInvitations');
        spies.push(sent, calendarShares, invitations);

        await requestOtp(email, '192.0.2.71');
        const otp = sent.mock.calls[0]?.[0].text.match(/\b(\d{6})\b/)?.[1];
        if (!otp) throw new Error('no code in the mail');
        const signIn = await verifyOtpAndSignIn(email, otp, '192.0.2.71');
        const sessionToken = signIn.headers.get('set-cookie')?.match(/better-auth\.session_token=([^;]+)/)?.[1];
        if (!sessionToken) throw new Error('no session cookie');
        const guest = await getUserByEmail(email);
        if (!guest) throw new Error('guest missing');

        const shared = await assertJson<DrivePath[]>(
            await authedRequest(sessionToken, `/drive/${guest.id}/shared/with-me`),
        );
        expect(shared.some((path) => path.name === folderName)).toBe(true);
        expect(calendarShares).not.toHaveBeenCalled();
        expect(invitations).not.toHaveBeenCalled();
    });

    async function aliceFolderAndRoot(): Promise<{ root: DrivePath; folder: DrivePath }> {
        const alice = await getHome(ctx.alice.user.id);
        const root = await assertJson<DrivePath>(
            await authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/default/root`),
        );
        const folder = await alice.drive.createFolder('default', root.id, crypto.randomUUID(), alice.user);
        return { root, folder };
    }

    async function aliceShares(parentId: string, id: string): Promise<DrivePath> {
        const alice = await getHome(ctx.alice.user.id);
        const name = `${crypto.randomUUID()}.txt`;
        const file = await alice.drive.createFileFromData(
            'default',
            parentId,
            name,
            'text/plain',
            Buffer.from('x'),
            alice.user,
        );
        await alice.drive.updateACLDelta(
            'default',
            file.id,
            { add: [{ id, read: true, write: false }] },
            undefined,
            undefined,
            alice.user,
        );
        await relay.drainHomeDeliveries();
        return file;
    }

    async function sharedWithMe(token: string, userId: string): Promise<string[]> {
        const list = await assertJson<DrivePath[]>(await authedRequest(token, `/drive/${userId}/shared/with-me`));
        return list.map((path) => path.id);
    }

    test('an account created while a shared folder is in the trash sees the file after the restore', async () => {
        const alice = await getHome(ctx.alice.user.id);
        const email = `recon-trash-${crypto.randomUUID()}@test.eigen.is`;
        const { folder } = await aliceFolderAndRoot();
        const file = await aliceShares(folder.id, email);

        await alice.drive.deletePath('default', folder.id, alice.user);
        const created = await createTestUser(email, 'testpassword123', 'Late');
        await relay.drainHomeDeliveries();
        expect(await sharedWithMe(created.sessionToken, created.id)).not.toContain(file.id);
        await alice.drive.restorePath('default', folder.id, alice.user);

        expect(await sharedWithMe(created.sessionToken, created.id)).toContain(file.id);
    });

    test('a member who joins a team while its shared file is in the trash sees it after the restore', async () => {
        const orgId = getServerConfig()?.orgId;
        if (!orgId) throw new Error('the test server has no org');
        await authedRequest(ctx.alice.user.sessionToken, '/auth/organization/set-active', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: orgId }),
        });
        const teamId = await createTeam(ctx, orgId, `Recon trash ${crypto.randomUUID()}`);
        const alice = await getHome(ctx.alice.user.id);
        const { root } = await aliceFolderAndRoot();
        const file = await aliceShares(root.id, teamOwnerId(teamId));
        const member = await createTestUser(
            `recon-member-${crypto.randomUUID()}@test.eigen.is`,
            'testpassword123',
            'M',
        );

        await alice.drive.deletePath('default', file.id, alice.user);
        await addMember(ctx, teamId, member.id);
        await relay.drainHomeDeliveries();
        await alice.drive.restorePath('default', file.id, alice.user);

        expect(await sharedWithMe(member.sessionToken, member.id)).toContain(file.id);
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

        const running = reconcileShares(user);
        await pulling;
        await evictHome(user.id);
        openGate();
        await running;

        expect(await storedPermission(user.id, share.calendarId)).toBe('read');
    });
});
