import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { SSEventType } from '@workspace/lib/types/sse';
import { getHome } from '../../lib/home';
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

        const orgEventId = `ext-occurrence-${randomUUID()}`;
        const orgUserId = 'external_org@example.com';
        await home.calendar.createEvent(shared.id, {
            title: 'Weekly Sync',
            startTime: new Date('2026-07-06T09:00:00Z'),
            endTime: new Date('2026-07-06T10:00:00Z'),
            allDay: false,
            rrule: 'FREQ=WEEKLY;COUNT=5',
            data: {
                organizer: { userId: orgUserId, email: 'org@example.com', name: 'Org' },
                organizerEventId: orgEventId,
                attendees: [{ email: ctx.alice.user.email, status: 'accepted', role: 'required' }],
            },
        });

        const sse = await collectSSE(ctx.charlie.user.id);
        try {
            await home.calendar.cancelInvitationOccurrence(
                orgEventId,
                orgUserId,
                '2026-07-13',
                new Date('2026-07-13T09:00:00Z'),
                { sequence: 1, dtstamp: new Date() },
            );

            await eventually(
                async () => (sse.events.some((e) => e.type === SSEventType.CALENDAR_EVENT_UPDATED) ? true : undefined),
                "the sharee's tabs to hear about the cancelled occurrence",
            );
        } finally {
            sse.stop();
        }
    });

    // A re-received invite lands under a fresh name, so one sync delta carries the deleted resource as a
    // 404 and the new one as a 200 — never one href as both. Driven at the domain level, like the linked-
    // event seeding in calendar.test.ts: the REST layer has no re-invite-after-delete flow to exercise it.
    describe('Re-received invitation after local delete', () => {
        test('syncs once as a 200 with a non-null eventCtag and no 404 tombstone', async () => {
            const bobHome = await getHome(ctx.bob.user.id);
            const cal = bobHome.calendar;
            const defaultCal = findOrFail(await cal.getCalendars(), (c) => c.isDefault);
            const uid = `reinvite-${randomUUID()}`;
            const payload = {
                uid,
                title: 'Re-received Invite',
                description: null,
                location: null,
                startTime: new Date('2026-11-10T09:00:00Z'),
                endTime: new Date('2026-11-10T10:00:00Z'),
                allDay: false,
                rrule: null,
                timezone: null,
                status: 'confirmed' as const,
                sequence: 0,
                data: {
                    organizer: { userId: ctx.alice.user.id, email: ctx.alice.user.email, name: 'Alice' },
                    organizerEventId: `org-${uid}`,
                },
                createByUserId: ctx.alice.user.id,
                organizerEventId: `org-${uid}`,
                organizerUserId: ctx.alice.user.id,
            };

            const firstId = await cal.receiveInvitation(payload);
            const firstUri = findOrFail(await cal.listResources(defaultCal.id), (r) => r.uid === uid).uri;
            // The client's sync token, captured after the first receive and before the delete + re-receive.
            const preCtag = (await cal.getCalendarById(defaultCal.id))!.ctag;

            await cal.deleteEvent(defaultCal.id, firstId!); // Bob deletes his linked copy → tombstones the uri
            const secondId = await cal.receiveInvitation(payload); // Alice re-sends the same invite
            expect(secondId).not.toBe(firstId);

            const changed = (await cal.getChangedResourcesSince(defaultCal.id, preCtag)).filter((r) => r.uid === uid);
            const deleted = await cal.getDeletedResourcesSince(defaultCal.id, preCtag);
            expect(changed).toHaveLength(1);
            expect(changed[0].uri).not.toBe(firstUri);
            expect(deleted.map((d) => d.uri)).toContain(firstUri);
            expect(deleted.some((d) => d.uri === changed[0].uri)).toBe(false);
        });

        test('a second link on one UID is dropped, and never a second master', async () => {
            const bobHome = await getHome(ctx.bob.user.id);
            const cal = bobHome.calendar;
            const defaultCal = findOrFail(await cal.getCalendars(), (c) => c.isDefault);
            const uid = `collide-${randomUUID()}`;
            const payload = {
                uid,
                title: 'Colliding Invite',
                description: null,
                location: null,
                startTime: new Date('2026-11-12T09:00:00Z'),
                endTime: new Date('2026-11-12T10:00:00Z'),
                allDay: false,
                rrule: null,
                timezone: null,
                status: 'confirmed' as const,
                sequence: 0,
                data: {
                    organizer: { userId: ctx.alice.user.id, email: ctx.alice.user.email, name: 'Alice' },
                    organizerEventId: `org-a-${uid}`,
                },
                createByUserId: ctx.alice.user.id,
                organizerEventId: `org-a-${uid}`,
                organizerUserId: ctx.alice.user.id,
            };
            await cal.receiveInvitation(payload);
            const preCtag = (await cal.getCalendarById(defaultCal.id))!.ctag;

            // The same uid under another organizer key slips past the linked-event dedupe; the calendar
            // already holds that UID, so the invitation is dropped instead of throwing on the unique
            // index, and it leaves no phantom ctag bump for every client to poll an empty delta for.
            const second = await cal.receiveInvitation({
                ...payload,
                organizerEventId: `org-b-${uid}`,
                organizerUserId: ctx.charlie.user.id,
            });
            expect(second).toBeNull();
            expect((await cal.getCalendarById(defaultCal.id))!.ctag).toBe(preCtag);
            expect(await cal.getEventsByUid(uid)).toHaveLength(1);
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
                (e) => e.title === 'Self-Invite Test' && e.data?.organizer,
            );
            expect(selfInviteCopies).toHaveLength(0);
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

        // An older client names an occurrence by its full instant, and an unkeyable value is a bad request.
        test('a this-and-following decline keys a full ISO instant and refuses what keys to nothing', async () => {
            await createRecurringInvite('Weekly Del Iso');
            const linked = await bobOccurrence((e) => e.title === 'Weekly Del Iso' && !e.parentEventId);
            const occurrences = (await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id)).filter(
                (e: CalendarEventOccurrence) => e.title === 'Weekly Del Iso',
            );
            expect(occurrences.length).toBe(5);

            const bad = await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this-and-following',
                recurrenceDate: 'the second one',
                remove: true,
            });
            expect(bad.status).toBe(400);

            const res = await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this-and-following',
                recurrenceDate: new Date(occurrences[1].startTime).toISOString(),
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
            const mailer = await import('../../lib/core/mailer');
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

    // Every write path must hash the etag over the same basis. receiveRsvpForOccurrence used to
    // omit `timezone`, so a byte-identical repeat RSVP flipped the exception's etag and triggered a
    // spurious CalDAV re-download.
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
        expect(messages.some((message) => message.includes('calendar:invitation'))).toBe(true);
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

    // The client cannot declare itself an invitee (EventDataSchema strips organizer), so the linked copy is
    // seeded through the domain, the way a CalDAV PUT or an import would leave one behind.
    const seed = async (title: string, attendeeEmail: string, organizer = STRANGER) => {
        const home = await getHome(ctx.bob.user.id);
        return home.calendar.createEvent(calendarId, {
            title,
            startTime: new Date('2026-12-01T09:00:00Z'),
            endTime: new Date('2026-12-01T10:00:00Z'),
            allDay: false,
            data: {
                organizer: { userId: '', email: organizer, name: 'Stranger' },
                organizerEventId: `stranger-${randomUUID()}`,
                attendees: [{ email: attendeeEmail, status: 'pending', role: 'required' }],
            },
        });
    };

    const removeEvent = (id: string) =>
        authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars/${calendarId}/events/${id}`, {
            method: 'DELETE',
        });

    const declinesTo = async (id: string): Promise<number> => {
        const mailer = await import('../../lib/core/mailer');
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
