import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { teamOwnerId } from '@workspace/lib/types';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { SSEventType } from '@workspace/lib/types/sse';
import { getServerConfig } from '../../lib/config/server-config';
import { getHome } from '../../lib/home';
import type { ParsedEvent } from '../../lib/ical/ical-parse';
import { vcal } from '../ics-test-helpers';
import { assertJson, authedRequest, collectSSE, eventually, findOrFail, getTestContext } from '../setup';

describe('Calendar Invites', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
        const calendars = await assertJson<CalendarItem[]>(res);
        aliceCalendarId = findOrFail(calendars, (c) => c.isDefault).id;
    });

    async function createEventWithAttendees(title: string, attendees: { email: string; name?: string }[]) {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    startTime: new Date(Date.now() + 3600_000),
                    endTime: new Date(Date.now() + 7200_000),
                    allDay: false,
                    data: {
                        attendees: attendees.map((a) => ({ ...a, status: 'pending', role: 'required' })),
                    },
                }),
            },
        );
        return assertJson<CalendarEvent>(res);
    }

    async function getBobEvents() {
        const from = Math.floor(Date.now() / 1000) - 86400;
        const to = Math.floor(Date.now() / 1000) + 86400 * 7;
        const eventsRes = await authedRequest(
            ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
        );
        return assertJson<CalendarEventOccurrence[]>(eventsRes);
    }

    // The fan-out is fire-and-forget: Bob's Home writes its own file after Alice's call answered.
    function bobEvent(predicate: (e: CalendarEventOccurrence) => boolean) {
        return eventually(async () => (await getBobEvents()).find(predicate), "the invitation to reach Bob's calendar");
    }

    async function aliceEvents() {
        const from = Math.floor(Date.now() / 1000) - 86400;
        const to = Math.floor(Date.now() / 1000) + 86400 * 7;
        return assertJson<CalendarEventOccurrence[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
            ),
        );
    }

    function aliceEvent(predicate: (e: CalendarEventOccurrence) => boolean) {
        return eventually(async () => (await aliceEvents()).find(predicate), "the reply to reach Alice's calendar");
    }

    describe('Invite propagation', () => {
        let inviteEvent: CalendarEvent;

        test('create event with attendees propagates to attendee', async () => {
            inviteEvent = await createEventWithAttendees('Team Standup', [{ email: ctx.bob.user.email, name: 'Bob' }]);

            expect(inviteEvent.data!.attendees).toHaveLength(1);
            expect(inviteEvent.data!.attendees![0].email).toBe(ctx.bob.user.email);
            expect(inviteEvent.sequence).toBe(0);

            const linked = await bobEvent((e) => e.title === 'Team Standup');
            expect(linked.data!.organizer!.userId).toBe(ctx.alice.user.id);
            expect(linked.data!.organizer!.email).toBe(ctx.alice.user.email);
            expect(linked.data!.organizerEventId).toBe(inviteEvent.id);
            // Unlike a mailed file, the relayed REQUEST lists the guests alone, never the organizer.
            expect(linked.data?.attendees?.map((a) => a.email)).toEqual([ctx.bob.user.email]);
        });

        test('exactly one linked copy reaches the attendee', async () => {
            const bobEvents = await getBobEvents();
            const linked = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Team Standup');
            expect(linked).toHaveLength(1);
        });

        test('attendee RSVP accepted', async () => {
            const linked = await bobEvent((e) => e.title === 'Team Standup');

            const bobCalsRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`);
            const bobCalId = findOrFail(await assertJson<CalendarItem[]>(bobCalsRes), (c) => c.isDefault).id;

            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${bobCalId}/events/${linked.id}/rsvp`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'accepted' }),
                },
            );
            expect(res.status).toBe(200);

            // Check organizer's event reflects the RSVP
            await aliceEvent((e) => e.title === 'Team Standup' && e.data?.attendees?.[0].status === 'accepted');
        });

        test('RSVP on non-linked event fails', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${inviteEvent.id}/rsvp`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'accepted' }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('RSVP by non-attendee fails', async () => {
            const linked = await bobEvent((e) => e.title === 'Team Standup');
            const bobCalsRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`);
            const bobCalId = findOrFail(await assertJson<CalendarItem[]>(bobCalsRes), (c) => c.isDefault).id;

            // Charlie is not an attendee
            const res = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/calendar/${ctx.charlie.user.id}/calendars/${bobCalId}/events/${linked.id}/rsvp`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'accepted' }),
                },
            );
            expect(res.status).not.toBe(200);
        });
    });

    describe('Update propagation', () => {
        test('organizer update propagates to attendee', async () => {
            const event = await createEventWithAttendees('Planning Session', [{ email: ctx.bob.user.email }]);

            // Update title
            const updateRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Planning Session v2',
                        data: { attendees: event.data!.attendees },
                    }),
                },
            );
            expect(updateRes.status).toBe(200);

            await bobEvent((e) => e.title === 'Planning Session v2');
        });
    });

    describe('Cancellation', () => {
        test('organizer delete cancels attendee copies', async () => {
            const event = await createEventWithAttendees('Doomed Meeting', [{ email: ctx.bob.user.email }]);
            await bobEvent((e) => e.title === 'Doomed Meeting');

            // Delete it
            const delRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
                {
                    method: 'DELETE',
                },
            );
            expect(delRes.status).toBe(200);

            await eventually(
                async () => ((await getBobEvents()).some((e) => e.title === 'Doomed Meeting') ? undefined : true),
                "Bob's linked copy to be canceled",
            );
        });

        test('attendee delete declines on organizer', async () => {
            await createEventWithAttendees('Optional Meeting', [{ email: ctx.bob.user.email }]);

            const linked = await bobEvent((e) => e.title === 'Optional Meeting');

            const bobCalsRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`);
            const bobCalId = findOrFail(await assertJson<CalendarItem[]>(bobCalsRes), (c) => c.isDefault).id;

            const delRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${bobCalId}/events/${linked.id}`,
                {
                    method: 'DELETE',
                },
            );
            expect(delRes.status).toBe(200);

            // Organizer should see declined status
            await aliceEvent((e) => e.title === 'Optional Meeting' && e.data?.attendees?.[0].status === 'declined');
        });
    });

    // Cancelling one occurrence writes the attendee's own calendar, so every Home that calendar is shared
    // with owes an announcement — the attendee's own tabs already hear it as CALENDAR_INVITE_CANCELLED.
    test('cancelling one occurrence of a linked series reaches the Homes the calendar is shared with', async () => {
        const home = await getHome(ctx.alice.user.id);
        const shared = await home.calendar.createCalendar({ name: 'Shared invites', color: '#aabbcc' });
        await home.calendar.updateCalendar(shared.id, {
            shares: [{ targetId: ctx.charlie.user.email, permission: 'read' }],
        });

        const orgEventId = `ext-occurrence-${crypto.randomUUID()}`;
        const orgUserId = 'external_org@example.com';
        await home.calendar.receiveRequest(
            [
                {
                    uid: orgEventId,
                    title: 'Weekly Sync',
                    description: null,
                    location: null,
                    startTime: new Date('2026-07-06T09:00:00Z'),
                    endTime: new Date('2026-07-06T10:00:00Z'),
                    allDay: false,
                    rrule: 'FREQ=WEEKLY;COUNT=5',
                    timezone: null,
                    status: 'confirmed',
                    sequence: 0,
                    dtstamp: null,
                    recurrenceDate: null,
                    recurrenceId: null,
                    data: {
                        organizer: { email: 'org@example.com', name: 'Org' },
                        attendees: [{ email: ctx.alice.user.email, status: 'accepted', role: 'required' }],
                    },
                },
            ],
            {
                organizerEmail: 'org@example.com',
                organizerEventId: orgEventId,
                organizerUserId: orgUserId,
                createByUserId: orgUserId,
            },
        );
        const copy = findOrFail(await home.calendar.getEventsByUid(orgEventId), () => true);
        await home.calendar.moveEvent(copy.calendarId, copy.id, shared.id);

        const sse = await collectSSE(ctx.charlie.user.id);
        try {
            await home.calendar.cancelInvitationOccurrence(orgEventId, orgUserId, {
                recurrenceDate: '2026-07-13',
                recurrenceId: { instant: new Date('2026-07-13T09:00:00Z'), timezone: null },
                sequence: 1,
                dtstamp: new Date(),
            });

            await eventually(
                async () => (sse.events.some((e) => e.type === SSEventType.CALENDAR_EVENT_UPDATED) ? true : undefined),
                "the sharee's tabs to hear about the cancelled occurrence",
            );
        } finally {
            sse.stop();
        }
    });

    // A re-received invite lands under a fresh name, so one sync delta carries the deleted resource as a
    // 404 and the new one as a 200, never one href as both.
    describe('Re-received invitation after local delete', () => {
        const relayed = (uid: string, title: string, organizerEmail: string, sequence = 0): ParsedEvent => ({
            uid,
            title,
            description: null,
            location: null,
            startTime: new Date('2026-11-12T09:00:00Z'),
            endTime: new Date('2026-11-12T10:00:00Z'),
            allDay: false,
            rrule: null,
            timezone: null,
            status: 'confirmed',
            sequence,
            dtstamp: null,
            recurrenceDate: null,
            recurrenceId: null,
            data: { organizer: { userId: ctx.alice.user.id, email: organizerEmail, name: 'Alice' } },
        });
        const linkOf = (organizerEventId: string, organizerUserId = ctx.alice.user.id) => ({
            organizerEmail: ctx.alice.user.email,
            organizerEventId,
            organizerUserId,
            createByUserId: organizerUserId,
        });

        // A deleted copy is no record of an answer, so the organizer's next save files it again, as a mailed one does.
        test("the organizer's next save files a deleted copy again, under a fresh name", async () => {
            const created = await createEventWithAttendees('Re-received Invite', [{ email: ctx.bob.user.email }]);
            await bobEvent((e) => e.title === 'Re-received Invite');
            const cal = (await getHome(ctx.bob.user.id)).calendar;
            const defaultCal = findOrFail(await cal.getCalendars(), (c) => c.isDefault);
            const first = findOrFail(await cal.listResources(defaultCal.id), (r) => r.uid === created.uid);
            const firstId = (await cal.getEventsByUid(created.uid))[0].id;
            // The client's sync token, captured after the first receive and before the delete and the re-receive.
            const preCtag = (await cal.getCalendarById(defaultCal.id))?.ctag ?? 0;

            await cal.deleteEvent(defaultCal.id, firstId);
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${created.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Re-received Invite, renamed' }),
                },
            );
            const changed = await eventually(async () => {
                const rows = (await cal.getChangedResourcesSince(defaultCal.id, preCtag)).filter(
                    (r) => r.uid === created.uid,
                );
                return rows.length ? rows : undefined;
            }, 'the copy filed again');

            const deleted = await cal.getDeletedResourcesSince(defaultCal.id, preCtag);
            expect(changed).toHaveLength(1);
            expect(changed[0].uri).not.toBe(first.uri);
            expect(deleted.map((d) => d.uri)).toContain(first.uri);
            expect(deleted.some((d) => d.uri === changed[0].uri)).toBe(false);
        });

        test('a second link on one UID is dropped, and never a second master', async () => {
            const cal = (await getHome(ctx.bob.user.id)).calendar;
            const defaultCal = findOrFail(await cal.getCalendars(), (c) => c.isDefault);
            const uid = `collide-${crypto.randomUUID()}`;
            await cal.receiveRequest([relayed(uid, 'Colliding Invite', ctx.alice.user.email)], linkOf(`org-a-${uid}`));
            const preCtag = (await cal.getCalendarById(defaultCal.id))?.ctag;

            // The same uid under another organizer key; the calendar already holds that UID, so the invitation is
            // dropped instead of throwing on the unique index, and it leaves no phantom ctag bump for every client
            // to poll an empty delta for.
            await cal.receiveRequest(
                [relayed(uid, 'Colliding Invite', ctx.alice.user.email, 1)],
                linkOf(`org-b-${uid}`, ctx.charlie.user.id),
            );
            expect((await cal.getCalendarById(defaultCal.id))?.ctag).toBe(preCtag);
            expect(await cal.getEventsByUid(uid)).toHaveLength(1);
        });

        test('an organizer with no name or address gets neutral notice titles', async () => {
            const bobHome = await getHome(ctx.bob.user.id);
            const cal = bobHome.calendar;
            const uid = `nameless-${crypto.randomUUID()}`;
            const orgEventId = `org-${uid}`;
            const nameless = (title: string, sequence: number): ParsedEvent => {
                const event = relayed(uid, title, '', sequence);
                return { ...event, data: { organizer: { userId: ctx.alice.user.id, email: '' } } };
            };
            const link = { ...linkOf(orgEventId), organizerEmail: '' };
            const persist = spyOn(bobHome.notifications, 'persist');
            try {
                await cal.receiveRequest([nameless('Nameless Invite', 0)], link);
                await cal.receiveRequest([nameless('Nameless Invite Moved', 1)], link);
                await cal.removeInvitation(orgEventId, ctx.alice.user.id);
                const notices = persist.mock.calls.map((call) => call[0]).filter((n) => n.tag?.includes(orgEventId));
                expect(notices.map((n) => n.title)).toEqual([
                    'New invitation',
                    'Invitation updated',
                    'Invitation canceled',
                ]);
            } finally {
                persist.mockRestore();
            }
        });
    });

    describe('Linked event guard', () => {
        test('attendee cannot change title/time on linked event', async () => {
            await createEventWithAttendees('Protected Event', [{ email: ctx.bob.user.email }]);

            const linked = await bobEvent((e) => e.title === 'Protected Event');
            const bobCalsRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`);
            const bobCalId = findOrFail(await assertJson<CalendarItem[]>(bobCalsRes), (c) => c.isDefault).id;

            // Try to change title — should be ignored by the guard
            const updateRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${bobCalId}/events/${linked.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Hacked Title' }),
                },
            );
            const updated = await assertJson<CalendarEvent>(updateRes);
            expect(updated.title).toBe('Protected Event'); // Title unchanged
        });
    });

    describe('Self-invite prevention', () => {
        test('organizer is not invited to their own event', async () => {
            await createEventWithAttendees('Self-Invite Test', [
                { email: ctx.alice.user.email }, // self
                { email: ctx.bob.user.email },
            ]);

            // Bob should have a linked copy
            await bobEvent((e) => e.title === 'Self-Invite Test');

            // Alice should not get one — only Bob
            const selfInviteCopies = (await aliceEvents()).filter(
                (e) => e.title === 'Self-Invite Test' && e.data?.organizerEventId,
            );
            expect(selfInviteCopies).toHaveLength(0);
        });

        // The event lands in the owner's own calendar, so the owner gets no copy, and the answer stays theirs to give.
        test("a collaborator inviting the calendar's owner leaves the owner's answer open", async () => {
            const home = await getHome(ctx.alice.user.id);
            const shared = await home.calendar.createCalendar({ name: 'Shared with Bob', color: '#ccbbaa' });
            await home.calendar.updateCalendar(shared.id, {
                shares: [{ targetId: ctx.bob.user.email, permission: 'write' }],
            });

            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${shared.id}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Owner Invited By Bob',
                        startTime: new Date(Date.now() + 3600_000),
                        endTime: new Date(Date.now() + 7200_000),
                        allDay: false,
                        data: {
                            attendees: [ctx.alice.user.email, ctx.charlie.user.email].map((email) => ({
                                email,
                                status: 'pending',
                                role: 'required',
                            })),
                        },
                    }),
                },
            );
            const created = await assertJson<CalendarEvent>(res);
            // The owner comes first on the list, so Charlie's copy means the fan-out went past them.
            const charlie = await getHome(ctx.charlie.user.id);
            await eventually(
                async () => ((await charlie.calendar.getEventsByUid(created.uid)).length ? true : undefined),
                "Charlie's copy",
            );

            const stored = (await aliceEvents()).filter((e) => e.title === 'Owner Invited By Bob');
            expect(stored).toHaveLength(1);
            expect(stored[0].calendarId).toBe(shared.id);
            const owner = findOrFail(stored[0].data?.attendees ?? [], (a) => a.email === ctx.alice.user.email);
            expect(owner.status).toBe('pending');
        });

        // A guest answers the ORGANIZER, and only the owner's Home holds the event, so the owner is named whoever saved.
        test("an event a collaborator saves names the calendar's owner as its organizer", async () => {
            const home = await getHome(ctx.alice.user.id);
            const shared = await home.calendar.createCalendar({ name: 'Organized by Alice', color: '#aabbcc' });
            await home.calendar.updateCalendar(shared.id, {
                shares: [{ targetId: ctx.bob.user.email, permission: 'write' }],
            });
            const mailer = await import('../../lib/mailer/mailer');
            const sent = spyOn(mailer, 'sendMail').mockResolvedValue(true);
            sent.mockClear();

            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${shared.id}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Saved By Bob',
                        startTime: new Date(Date.now() + 3600_000),
                        endTime: new Date(Date.now() + 7200_000),
                        allDay: false,
                        data: {
                            attendees: [ctx.charlie.user.email, 'outside.guest@external.com'].map((email) => ({
                                email,
                                status: 'pending',
                                role: 'required',
                            })),
                        },
                    }),
                },
            );
            const created = await assertJson<CalendarEvent>(res);
            const charlie = await getHome(ctx.charlie.user.id);
            const copy = await eventually(
                async () => (await charlie.calendar.getEventsByUid(created.uid))[0],
                "Charlie's copy",
            );
            const invite = await eventually(
                async () => sent.mock.calls.map((call) => call[0]).find((mail) => mail.icalEvent),
                'the mailed invitation',
            );
            sent.mockRestore();

            expect(copy.data?.organizer?.email).toBe(ctx.alice.user.email);
            expect(invite.from?.address).toBe(ctx.alice.user.email);
            const organizerLine = invite.icalEvent?.content.replace(/\r\n /g, '').match(/^ORGANIZER.*$/m)?.[0];
            expect(organizerLine).toEndWith(`:mailto:${ctx.alice.user.email}`);
        });
    });

    describe('Per-occurrence RSVP', () => {
        const baseTime = new Date('2026-06-01T10:00:00Z');
        const baseTimeSec = Math.floor(baseTime.getTime() / 1000);
        let bobCalId: string;

        async function createRecurringInvite(title: string) {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title,
                        startTime: baseTime,
                        endTime: new Date(baseTime.getTime() + 3600_000),
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;COUNT=5',
                        data: {
                            attendees: [
                                { email: ctx.bob.user.email, name: 'Bob', status: 'pending', role: 'required' },
                            ],
                        },
                    }),
                },
            );
            return assertJson<CalendarEvent>(res);
        }

        async function getBobCalId() {
            if (bobCalId) return bobCalId;
            const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`);
            bobCalId = findOrFail(await assertJson<CalendarItem[]>(res), (c) => c.isDefault).id;
            return bobCalId;
        }

        async function getEventsInRange(token: string, ownerId: string) {
            const from = baseTimeSec - 86400;
            const to = baseTimeSec + 86400 * 42;
            const res = await authedRequest(token, `/calendar/${ownerId}/event-range/${from}/${to}`);
            return assertJson<CalendarEventOccurrence[]>(res);
        }

        function bobOccurrence(predicate: (e: CalendarEventOccurrence) => boolean) {
            return eventually(
                async () => (await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id)).find(predicate),
                "the series to reach Bob's calendar",
            );
        }

        function aliceOccurrence(predicate: (e: CalendarEventOccurrence) => boolean) {
            return eventually(
                async () => (await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id)).find(predicate),
                "the reply to reach Alice's calendar",
            );
        }

        async function rsvpAs(bobLinkedId: string, body: Record<string, unknown>) {
            const calId = await getBobCalId();
            return authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${calId}/events/${bobLinkedId}/rsvp`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                },
            );
        }

        test('RSVP scope=this accepts a single occurrence', async () => {
            await createRecurringInvite('Weekly Scoped RSVP');
            const linked = await bobOccurrence((e) => e.title === 'Weekly Scoped RSVP');

            const res = await rsvpAs(linked.id, {
                status: 'accepted',
                scope: 'this',
                recurrenceDate: linked.occurrenceDate,
            });
            expect(res.status).toBe(200);

            // Organizer should see accepted for that occurrence, pending for others
            await aliceOccurrence(
                (e) =>
                    e.title === 'Weekly Scoped RSVP' &&
                    e.occurrenceDate === linked.occurrenceDate &&
                    e.data?.attendees?.[0].status === 'accepted',
            );
            const aliceEvents = await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id);
            const aliceOccs = aliceEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Scoped RSVP');
            const otherOccs = aliceOccs.filter(
                (e: CalendarEventOccurrence) => e.occurrenceDate !== linked.occurrenceDate,
            );
            expect(otherOccs.length).toBeGreaterThan(0);
            expect(otherOccs.every((e: CalendarEventOccurrence) => e.data!.attendees![0].status === 'pending')).toBe(
                true,
            );
        });

        test('RSVP scope=all accepts all occurrences', async () => {
            await createRecurringInvite('Weekly All RSVP');
            const linked = await bobOccurrence((e) => e.title === 'Weekly All RSVP');

            const res = await rsvpAs(linked.id, { status: 'accepted' });
            expect(res.status).toBe(200);

            await aliceOccurrence((e) => e.title === 'Weekly All RSVP' && e.data?.attendees?.[0].status === 'accepted');
            const aliceEvents = await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id);
            const aliceOccs = aliceEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly All RSVP');
            expect(aliceOccs.every((e: CalendarEventOccurrence) => e.data!.attendees![0].status === 'accepted')).toBe(
                true,
            );
        });

        test('delete scope=this removes one occurrence from attendee, declines on organizer', async () => {
            await createRecurringInvite('Weekly Del This');
            const linked = await bobOccurrence((e) => e.title === 'Weekly Del This');
            const targetDate = linked.occurrenceDate;

            const res = await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this',
                recurrenceDate: targetDate,
                remove: true,
            });
            expect(res.status).toBe(200);

            // Bob no longer sees that occurrence
            const bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const bobOccs = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Del This');
            expect(bobOccs.find((e: CalendarEventOccurrence) => e.occurrenceDate === targetDate)).toBeUndefined();
            expect(bobOccs.length).toBe(4); // 5 - 1

            // Organizer sees declined for that date
            await aliceOccurrence(
                (e) =>
                    e.title === 'Weekly Del This' &&
                    e.occurrenceDate === targetDate &&
                    e.data?.attendees?.[0].status === 'declined',
            );
        });

        test('delete scope=this-and-following removes future from attendee, declines series on organizer', async () => {
            await createRecurringInvite('Weekly Del Following');
            const linked = await bobOccurrence((e) => e.title === 'Weekly Del Following' && !e.parentEventId);

            let bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const bobOccs = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Del Following');
            expect(bobOccs.length).toBe(5);
            // Delete from 2nd occurrence onward
            const secondOcc = bobOccs[1];

            const res = await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this-and-following',
                recurrenceDate: secondOcc.occurrenceDate,
                remove: true,
            });
            expect(res.status).toBe(200);

            // Bob sees only the first occurrence
            bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const remaining = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Del Following');
            expect(remaining.length).toBe(1);
            expect(remaining[0].occurrenceDate).toBe(bobOccs[0].occurrenceDate);

            // Organizer sees declined
            await aliceOccurrence(
                (e) => e.title === 'Weekly Del Following' && e.data?.attendees?.[0].status === 'declined',
            );
        });

        test('a this-and-following decline refuses a full ISO instant and what keys to nothing', async () => {
            await createRecurringInvite('Weekly Del Iso');
            const linked = await bobOccurrence((e) => e.title === 'Weekly Del Iso' && !e.parentEventId);
            const occurrences = (await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id)).filter(
                (e: CalendarEventOccurrence) => e.title === 'Weekly Del Iso',
            );
            expect(occurrences.length).toBe(5);

            for (const recurrenceDate of ['the second one', new Date(occurrences[1].startTime).toISOString()]) {
                const bad = await rsvpAs(linked.id, {
                    status: 'declined',
                    scope: 'this-and-following',
                    recurrenceDate,
                    remove: true,
                });
                expect(bad.status).toBe(400);
            }

            const res = await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this-and-following',
                recurrenceDate: occurrences[1].occurrenceDate,
                remove: true,
            });
            expect(res.status).toBe(200);

            const remaining = (await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id)).filter(
                (e: CalendarEventOccurrence) => e.title === 'Weekly Del Iso',
            );
            expect(remaining.length).toBe(1);
        });

        test('organizer truncate does not extend attendee past their own truncation', async () => {
            const event = await createRecurringInvite('Weekly Constrain');
            const linked = await bobOccurrence((e) => e.title === 'Weekly Constrain' && !e.parentEventId);

            let bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const bobOccs = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Constrain');
            expect(bobOccs.length).toBe(5);

            // Bob deletes from 2nd occurrence onward (keeps 1)
            await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this-and-following',
                recurrenceDate: bobOccs[1].occurrenceDate,
                remove: true,
            });

            bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            expect(bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Constrain').length).toBe(1);

            // Now Alice truncates from 4th occurrence (keeps 3) — broader than Bob's truncation
            const aliceRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        rrule: `FREQ=WEEKLY;UNTIL=${new Date(baseTime.getTime() + 86400_000 * 20).toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
                        data: { attendees: event.data!.attendees },
                    }),
                },
            );
            expect(aliceRes.status).toBe(200);
            // The update has landed on Bob's copy once it carries the organizer's new revision.
            await bobOccurrence((e) => e.title === 'Weekly Constrain' && !e.parentEventId && e.sequence === 1);

            // Bob should still see only 1 occurrence — not re-expanded
            bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const constrained = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Constrain');
            expect(constrained.length).toBe(1);
        });
    });

    // An attendee editing a local-only field (reminder) on their linked copy must NOT run the
    // organizer fan-out. Pre-fix it bumped the linked copy's SEQUENCE and sent an iMIP "Updated
    // invitation" to external co-attendees with the attendee spoofed as ORGANIZER — and because the
    // bumped SEQUENCE then outran the organizer's, the organizer's next real update was dropped by the
    // RFC 5546 replay guard (silent data-desync).
    describe('#9 attendee edit does not fan out', () => {
        const CAROL = 'carol.external@example.org';
        let bobCalId: string;
        let linkedId: string;

        async function rangeFor(token: string, ownerId: string) {
            const from = Math.floor(Date.now() / 1000) - 86400;
            const to = Math.floor(Date.now() / 1000) + 86400 * 60;
            return assertJson<CalendarEventOccurrence[]>(
                await authedRequest(token, `/calendar/${ownerId}/event-range/${from}/${to}`),
            );
        }

        function untilBob(predicate: (e: CalendarEventOccurrence) => boolean) {
            return eventually(
                async () => (await rangeFor(ctx.bob.user.sessionToken, ctx.bob.user.id)).find(predicate),
                "the fan-out to reach Bob's calendar",
            );
        }

        beforeAll(async () => {
            bobCalId = findOrFail(
                await assertJson<CalendarItem[]>(
                    await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`),
                ),
                (c) => c.isDefault,
            ).id;
        });

        test('setup: Alice invites Bob (internal) + Carol (external)', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Fanout Meeting',
                        startTime: new Date(Date.now() + 86400_000 * 30),
                        endTime: new Date(Date.now() + 86400_000 * 30 + 3600_000),
                        allDay: false,
                        data: {
                            attendees: [
                                { email: ctx.bob.user.email, status: 'pending', role: 'required' },
                                { email: CAROL, status: 'pending', role: 'required' },
                            ],
                        },
                    }),
                },
            );
            const linked = await untilBob((e) => e.title === 'Fanout Meeting');
            linkedId = linked.id;
            expect(linked.sequence).toBe(0);
        });

        test('Bob toggling a reminder does not bump SEQUENCE or send a spoofed iMIP update', async () => {
            const mailer = await import('../../lib/mailer/mailer');
            const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
            spy.mockClear();

            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${bobCalId}/events/${linkedId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: { reminders: [{ type: 'notification', minutes: 10 }] } }),
                },
            );
            const updated = await assertJson<CalendarEvent>(res);

            // The fan-out is fire-and-forget, so absence only counts behind a mail that IS expected: the
            // organizer's own edit, made second, mails Carol through the very path Bob's edit must not take.
            const orig = findOrFail(
                await rangeFor(ctx.alice.user.sessionToken, ctx.alice.user.id),
                (e) => e.title === 'Fanout Meeting',
            );
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${orig.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ location: 'Room A' }),
                },
            );
            const toCarol = () => spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === CAROL));
            await eventually(
                async () => toCarol().some((c) => c[0].from?.address === ctx.alice.user.email) || undefined,
                "the organizer's own update to reach Carol",
            );

            expect(updated.sequence).toBe(0); // pre-fix: 1
            // pre-fix: a second one, ORGANIZER=Bob, composed before the organizer's own
            expect(toCarol()).toHaveLength(1);
            spy.mockRestore();
        });

        test("kill shot: the organizer's next real update still reaches Bob", async () => {
            const orig = findOrFail(
                await rangeFor(ctx.alice.user.sessionToken, ctx.alice.user.id),
                (e) => e.title === 'Fanout Meeting',
            );
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${orig.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Fanout Meeting V2' }),
                },
            );
            // pre-fix: dropped by the replay guard (Bob's SEQUENCE had outrun the organizer's)
            await untilBob((e) => e.id === linkedId && e.title === 'Fanout Meeting V2');
        });
    });

    // Every write path must hash the etag over the same basis, or a byte-identical repeat RSVP
    // flips the exception's etag and triggers a spurious CalDAV re-download.
    describe('#24 occurrence-RSVP etag consistency', () => {
        const from = Math.floor(Date.parse('2026-03-09T00:00:00Z') / 1000);
        const to = Math.floor(Date.parse('2026-03-16T00:00:00Z') / 1000);
        let bobCalId: string;
        // The master linked event's id, captured BEFORE the first per-occurrence RSVP: once an
        // exception exists, event-range substitutes it and the occurrence carries the exception row's id.
        let linkedMasterId: string;

        async function rsvpThis(status: 'accepted' | 'tentative') {
            await assertJson(
                await authedRequest(
                    ctx.bob.user.sessionToken,
                    `/calendar/${ctx.bob.user.id}/calendars/${bobCalId}/events/${linkedMasterId}/rsvp`,
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status, scope: 'this', recurrenceDate: '2026-03-12' }),
                    },
                ),
            );
        }

        async function findExceptionOccurrence() {
            const events = await assertJson<CalendarEventOccurrence[]>(
                await authedRequest(
                    ctx.bob.user.sessionToken,
                    `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
                ),
            );
            return findOrFail(
                events,
                (e) => e.title === 'Etag Audit' && new Date(e.startTime).toISOString() === '2026-03-13T03:00:00.000Z',
            );
        }

        test('identical repeated occurrence-RSVP keeps the exception etag stable', async () => {
            bobCalId = findOrFail(
                await assertJson<CalendarItem[]>(
                    await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`),
                ),
                (c) => c.isDefault,
            ).id;
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Etag Audit',
                        startTime: '2026-03-06T04:00:00Z', // Thu Mar 5, 23:00 America/New_York (EST)
                        endTime: '2026-03-06T04:30:00Z',
                        allDay: false,
                        rrule: 'FREQ=WEEKLY',
                        timezone: 'America/New_York',
                        data: { attendees: [{ email: ctx.bob.user.email, status: 'pending', role: 'required' }] },
                    }),
                },
            );
            linkedMasterId = (
                await eventually(async () => {
                    const events = await assertJson<CalendarEventOccurrence[]>(
                        await authedRequest(
                            ctx.bob.user.sessionToken,
                            `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
                        ),
                    );
                    return events.find((e) => e.title === 'Etag Audit');
                }, "the invitation to reach Bob's calendar")
            ).id;

            await rsvpThis('accepted');
            const occ1 = await findExceptionOccurrence();
            expect(occ1.data?.attendees?.[0]?.status).toBe('accepted');

            await rsvpThis('accepted');
            const occ2 = await findExceptionOccurrence();

            // Identical content — the etag must not change.
            expect(occ2.etag).toBe(occ1.etag);
        });

        test('control: an RSVP that changes the status does change the etag', async () => {
            const before = await findExceptionOccurrence();
            await rsvpThis('tentative');
            const after = await findExceptionOccurrence();
            expect(after.data?.attendees?.[0]?.status).toBe('tentative');
            expect(after.etag).not.toBe(before.etag);
        });
    });

    // Transports stay projected (R17 6a): the receiving Home builds its own file from the payload's
    // fields, so no `X-EIGEN-` line ever crosses a home boundary.
    test('a relay invitation carries no X-EIGEN- line', async () => {
        const relay = await import('../../lib/home/home-relay');
        const spy = spyOn(relay, 'sendToHome');
        spy.mockClear();

        await createEventWithAttendees('Projected Payload', [{ email: ctx.bob.user.email }]);
        await bobEvent((e) => e.title === 'Projected Payload');

        const messages = spy.mock.calls.map((call) => JSON.stringify(call[1]));
        expect(messages.some((message) => message.includes('calendar:request'))).toBe(true);
        expect(messages.some((message) => message.toUpperCase().includes('X-EIGEN'))).toBe(false);
        spy.mockRestore();
    });
});

// A decline is an RSVP, and only an attendee has one to give. A file or a CalDAV client can hang any
// ORGANIZER on an event the user wrote themselves; without the guard, deleting it mails a stranger a
// REPLY saying the user declined a meeting they were never invited to.
describe('Delete-as-decline is for attendees only', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let calendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`);
        calendarId = findOrFail(await assertJson<CalendarItem[]>(res), (c) => c.isDefault).id;
    });

    const STRANGER = 'stranger@external.com';
    // The control's own organizer: a second delete whose decline IS expected, so absence is measured
    // against a mail that arrived rather than against nothing at all.
    const CONTROL = 'control@external.com';

    // The web app cannot name an organizer (EventDataSchema strips it), so the event comes in as a CalDAV PUT would.
    const seed = async (title: string, attendeeEmail: string, organizer = STRANGER) => {
        const { calendar } = await getHome(ctx.bob.user.id);
        const uid = crypto.randomUUID();
        const body = vcal([
            'BEGIN:VEVENT',
            `UID:${uid}`,
            'DTSTART:20261201T090000Z',
            'DTEND:20261201T100000Z',
            `SUMMARY:${title}`,
            `ORGANIZER;CN=Stranger:mailto:${organizer}`,
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${attendeeEmail}`,
            'END:VEVENT',
        ]);
        expect(
            (await calendar.putResource(calendarId, `${uid}.ics`, body, { ifMatch: null, ifNoneMatch: null })).ok,
        ).toBe(true);
        return findOrFail(await calendar.getEventsByUid(uid), () => true);
    };

    const removeEvent = (id: string) =>
        authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars/${calendarId}/events/${id}`, {
            method: 'DELETE',
        });

    const declinesTo = async (id: string): Promise<number> => {
        const mailer = await import('../../lib/mailer/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear();
        const mailsTo = (address: string) =>
            spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === address)).length;

        expect((await removeEvent(id)).status).toBe(200);
        // Deleted second, so its decline is composed behind whatever the first delete owed.
        const control = await seed('Control meeting', ctx.bob.user.email, CONTROL);
        expect((await removeEvent(control.id)).status).toBe(200);
        await eventually(async () => mailsTo(CONTROL) || undefined, "the control delete's decline");

        const count = mailsTo(STRANGER);
        spy.mockRestore();
        return count;
    };

    test('deleting an event the user is not an attendee of mails the organizer nothing', async () => {
        const event = await seed('Not my meeting', 'someone.else@external.com');
        expect(await declinesTo(event.id)).toBe(0);
    });

    test('deleting one the user is an attendee of still declines, whatever case the file spells', async () => {
        const event = await seed('My meeting', ctx.bob.user.email.toUpperCase());
        expect(await declinesTo(event.id)).toBe(1);
    });
});

describe('The invitation mail of one save', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let calendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
        calendarId = findOrFail(await assertJson<CalendarItem[]>(res), (c) => c.isDefault).id;
    });

    const GUESTS = ['one@external.com', 'two@external.com', 'three@external.com'];

    test('is built once, and each guest gets it under their own address', async () => {
        const mailer = await import('../../lib/mailer/mailer');
        const ical = await import('../../lib/ical/ical-component');
        const mail = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        mail.mockClear();
        const build = spyOn(ical, 'serializeEventForImip');
        build.mockClear();

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${calendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'One body',
                    startTime: new Date(Date.now() + 3600_000),
                    endTime: new Date(Date.now() + 7200_000),
                    allDay: false,
                    data: { attendees: GUESTS.map((email) => ({ email, status: 'pending', role: 'required' })) },
                }),
            },
        );
        expect(res.status).toBe(200);
        const sent = await eventually(async () => {
            const calls = mail.mock.calls.map((call) => call[0]).filter((m) => m.subject === 'Invitation: One body');
            return calls.length === GUESTS.length ? calls : undefined;
        }, 'the invitation to reach every guest');

        expect(build).toHaveBeenCalledTimes(1);
        expect(sent.map((m) => m.to.map((t) => t.address))).toEqual(GUESTS.map((email) => [email]));
        const [first] = sent;
        for (const guest of GUESTS) expect(first.icalEvent?.content).toContain(`mailto:${guest}`);
        for (const m of sent) expect(m.icalEvent).toEqual(first.icalEvent);
        build.mockRestore();
        mail.mockRestore();
    });

    test('a guest on this server gets a notice with no calendar file, and none is built for them', async () => {
        const mailer = await import('../../lib/mailer/mailer');
        const ical = await import('../../lib/ical/ical-component');
        const mail = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        mail.mockClear();
        const build = spyOn(ical, 'serializeEventForImip');
        build.mockClear();

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${calendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Local notice',
                    startTime: new Date(Date.now() + 3600_000),
                    endTime: new Date(Date.now() + 7200_000),
                    allDay: false,
                    data: { attendees: [{ email: ctx.bob.user.email, status: 'pending', role: 'required' }] },
                }),
            },
        );
        expect(res.status).toBe(200);
        const notice = await eventually(
            async () => mail.mock.calls.map((call) => call[0]).find((m) => m.subject === 'Invitation: Local notice'),
            'the notice to Bob',
        );

        expect(notice.icalEvent).toBeUndefined();
        expect(build).not.toHaveBeenCalled();
        build.mockRestore();
        mail.mockRestore();
    });
});

describe('A save that changes nothing', () => {
    test('moves no ctag, announces nothing and mails no guest', async () => {
        const ctx = await getTestContext();
        const owner = ctx.alice.user;
        const calendar = (await getHome(owner.id)).calendar;
        const calendarId = findOrFail(await calendar.getCalendars(), (c) => c.isDefault).id;
        const eventUrl = (id: string) => `/calendar/${owner.id}/calendars/${calendarId}/events/${id}`;
        const save = (id: string, body: object) =>
            authedRequest(owner.sessionToken, eventUrl(id), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        const mailer = await import('../../lib/mailer/mailer');
        const mail = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        const mailed = (subject: string) => mail.mock.calls.filter((call) => call[0].subject === subject).length;

        const event = await assertJson<CalendarEvent>(
            await authedRequest(owner.sessionToken, `/calendar/${owner.id}/calendars/${calendarId}/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Restated',
                    description: 'Agenda',
                    location: 'Room 1',
                    startTime: new Date(Date.now() + 3600_000),
                    endTime: new Date(Date.now() + 7200_000),
                    allDay: false,
                    timezone: 'Europe/Amsterdam',
                    rrule: 'FREQ=WEEKLY',
                    data: {
                        url: 'https://example.com/agenda',
                        color: '#2563eb',
                        reminders: [{ type: 'notification', minutes: 10 }],
                        attendees: [
                            { email: 'restated@external.com', name: 'Guest', status: 'pending', role: 'required' },
                        ],
                    },
                }),
            }),
        );
        await eventually(async () => mailed('Invitation: Restated') || undefined, 'the invitation to reach the guest');
        const ctag = (await calendar.getCollection(calendarId))?.ctag;
        const sse = await collectSSE(owner.id);

        // The form restates every field on every save.
        const answer = await save(event.id, {
            title: event.title,
            description: event.description,
            location: event.location,
            startTime: event.startTime,
            endTime: event.endTime,
            allDay: event.allDay,
            timezone: event.timezone,
            rrule: event.rrule,
            data: event.data,
            etag: event.etag,
        });
        const unchanged = await assertJson<CalendarEvent>(answer);
        expect(unchanged.etag).toBe(event.etag);
        expect((await calendar.getCollection(calendarId))?.ctag).toBe(ctag);

        // Absence only counts behind what IS expected: a real edit, made second, takes the very path the save must not.
        expect((await save(event.id, { title: 'Really changed' })).status).toBe(200);
        await eventually(async () => mailed('Updated invitation: Really changed') || undefined, 'the real update');

        expect(mailed('Updated invitation: Restated')).toBe(0);
        expect(sse.events.filter((e) => e.type === SSEventType.CALENDAR_EVENT_UPDATED)).toHaveLength(1);
        sse.stop();
        mail.mockRestore();
    });
});

describe('A save only its owner sees', () => {
    const setup = async (title: string, input: { rrule?: string }) => {
        const ctx = await getTestContext();
        const owner = ctx.alice.user;
        const calendar = (await getHome(owner.id)).calendar;
        const calendarId = findOrFail(await calendar.getCalendars(), (c) => c.isDefault).id;
        const save = async (id: string, body: object) =>
            assertJson<CalendarEvent>(
                await authedRequest(owner.sessionToken, `/calendar/${owner.id}/calendars/${calendarId}/events/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                }),
            );
        const mailer = await import('../../lib/mailer/mailer');
        const mail = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        const mailed = (subject: string) => mail.mock.calls.filter((call) => call[0].subject === subject).length;
        const event = await assertJson<CalendarEvent>(
            await authedRequest(owner.sessionToken, `/calendar/${owner.id}/calendars/${calendarId}/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    startTime: new Date(Date.now() + 3600_000),
                    endTime: new Date(Date.now() + 7200_000),
                    allDay: false,
                    timezone: 'Europe/Amsterdam',
                    ...input,
                    data: { attendees: [{ email: 'personal@external.com', status: 'pending', role: 'required' }] },
                }),
            }),
        );
        await eventually(async () => mailed(`Invitation: ${title}`) || undefined, 'the invitation to reach the guest');
        return { owner, save, mail, mailed, event };
    };

    test('a color, a reminder or another spelling of the same instants mails nobody and moves no SEQUENCE', async () => {
        const { owner, save, mail, mailed, event } = await setup('Mine alone', {});
        const sse = await collectSSE(owner.id);
        const data = event.data ?? {};

        const colored = await save(event.id, { data: { ...data, color: '#2563eb' } });
        const reminded = await save(event.id, {
            data: { ...data, color: '#2563eb', reminders: [{ type: 'notification', minutes: 10 }] },
        });
        const respelled = await save(event.id, { timezone: 'Europe/London' });

        const etags = [event.etag, colored.etag, reminded.etag, respelled.etag];
        expect(new Set(etags).size).toBe(etags.length);
        expect(respelled.timezone).toBe('Europe/London');
        expect(respelled.startTime).toEqual(event.startTime);
        expect(respelled.sequence).toBe(event.sequence);

        // Absence only counts behind what IS expected: a real edit, made second, takes the very path the saves must not.
        await save(event.id, { title: 'Really mine' });
        await eventually(async () => mailed('Updated invitation: Really mine') || undefined, 'the real update');

        expect(mailed('Updated invitation: Mine alone')).toBe(0);
        expect(sse.events.filter((e) => e.type === SSEventType.CALENDAR_EVENT_UPDATED)).toHaveLength(4);
        sse.stop();
        mail.mockRestore();
    });

    // An older build stored an organizer's event with guests and no ORGANIZER line, and its next save writes one. Every
    // message names the organizer itself, so the line is no news to a guest.
    test.each([
        ['a reminder', { reminders: [{ type: 'notification', minutes: 10 }] }],
        ['a color', { color: '#2563eb' }],
    ])('the ORGANIZER line %s save adds to an event stored without one mails nobody', async (_change, data) => {
        const ctx = await getTestContext();
        const owner = ctx.alice.user;
        const { calendar } = await getHome(owner.id);
        const calendarId = findOrFail(await calendar.getCalendars(), (c) => c.isDefault).id;
        const uid = crypto.randomUUID();
        const GUEST = `bare-${uid}@external.com`;
        const body = vcal([
            'BEGIN:VEVENT',
            `UID:${uid}`,
            'DTSTART:20271201T090000Z',
            'DTEND:20271201T100000Z',
            'SUMMARY:Stored bare',
            `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${GUEST}`,
            'END:VEVENT',
        ]);
        expect(
            (await calendar.putResource(calendarId, `${uid}.ics`, body, { ifMatch: null, ifNoneMatch: null })).ok,
        ).toBe(true);
        const event = findOrFail(await calendar.getEventsByUid(uid), () => true);
        const save = (changes: object) =>
            authedRequest(owner.sessionToken, `/calendar/${owner.id}/calendars/${calendarId}/events/${event.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(changes),
            });
        const mailer = await import('../../lib/mailer/mailer');
        const mail = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        mail.mockClear();
        try {
            const saved = await assertJson<CalendarEvent>(await save({ data: { ...event.data, ...data } }));
            expect(saved.data?.organizer?.email).toBe(owner.email);
            expect(saved.sequence).toBe(event.sequence);

            // Absence only counts behind what IS expected: a rename, made second, takes the path the first save must not.
            expect((await save({ title: 'Stored bare renamed' })).status).toBe(200);
            const toGuest = () => mail.mock.calls.filter(([sent]) => sent.to.some((to) => to.address === GUEST));
            await eventually(async () => toGuest().length || undefined, 'the rename to reach the guest');
            expect(toGuest().map(([sent]) => sent.subject)).toEqual(['Updated invitation: Stored bare renamed']);
        } finally {
            mail.mockRestore();
        }
    });

    test('a repeating event in another zone moves its later occurrences, so the guests hear it', async () => {
        const { save, mail, mailed, event } = await setup('Weekly zone', { rrule: 'FREQ=WEEKLY' });

        await save(event.id, { timezone: 'America/New_York' });

        await eventually(async () => mailed('Updated invitation: Weekly zone') || undefined, 'the zone update');
        mail.mockRestore();
    });
});

// A team has no address, so a team event's ORGANIZER is the member who first gave it guests, and it stays theirs
// whoever saves it next: a guest's answer and every later message name that one organizer.
describe('The organizer a team event names', () => {
    test("a member's save of another member's event keeps the stored ORGANIZER", async () => {
        const ctx = await getTestContext();
        const [alice, bob] = [ctx.alice.user, ctx.bob.user];
        const orgId = getServerConfig()?.orgId;
        const post = (path: string, body: object, method = 'POST') =>
            authedRequest(alice.sessionToken, path, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        await post('/auth/organization/set-active', { organizationId: orgId });
        const team = await assertJson<{ id: string }>(
            await post('/auth/organization/create-team', {
                name: `Organizer ${crypto.randomUUID()}`,
                organizationId: orgId,
            }),
        );
        const owner = teamOwnerId(team.id);
        await post(`/team/${owner}/settings`, { calendar: { enabled: true } }, 'PUT');
        for (const member of [alice, bob]) {
            await post('/auth/organization/add-team-member', { teamId: team.id, userId: member.id });
        }
        const calendar = await assertJson<CalendarItem>(
            await post(`/calendar/${owner}/calendars`, { name: 'Team organizer', color: '#334455' }),
        );
        const events = `/calendar/${owner}/calendars/${calendar.id}/events`;
        await post(
            `/calendar/${owner}/calendars/${calendar.id}`,
            { shares: [{ targetId: owner, permission: 'write' }] },
            'PUT',
        );

        const GUEST = 'team-guest@external.com';
        const mailer = await import('../../lib/mailer/mailer');
        const mail = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        try {
            const event = await assertJson<CalendarEvent>(
                await post(events, {
                    title: 'Team review',
                    startTime: new Date(Date.now() + 3600_000),
                    endTime: new Date(Date.now() + 7200_000),
                    allDay: false,
                    data: { attendees: [{ email: GUEST, status: 'pending', role: 'required' }] },
                }),
            );
            expect(event.data?.organizer?.email).toBe(alice.email);

            const save = (body: object) =>
                authedRequest(bob.sessionToken, `${events}/${event.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
            const restated = await assertJson<CalendarEvent>(await save({ title: event.title, data: event.data }));
            expect(restated.etag).toBe(event.etag);

            mail.mockClear();
            const renamed = await assertJson<CalendarEvent>(await save({ title: 'Team review moved' }));
            expect(renamed.data?.organizer?.email).toBe(alice.email);
            const update = await eventually(
                async () => mail.mock.calls.map(([sent]) => sent).find((sent) => sent.to[0]?.address === GUEST),
                "Bob's update to reach the guest",
            );
            expect(update.icalEvent?.content.replace(/\r\n[ \t]/g, '')).toMatch(
                new RegExp(`\\r\\nORGANIZER[^\\r]*:mailto:${alice.email}\\r\\n`),
            );
        } finally {
            mail.mockRestore();
        }
    });
});
