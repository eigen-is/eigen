import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { getHome } from '../lib/home';
import { assertJson, authedRequest, findOrFail, getTestContext } from './setup';

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

    describe('Invite propagation', () => {
        let inviteEvent: CalendarEvent;

        test('create event with attendees propagates to attendee', async () => {
            inviteEvent = await createEventWithAttendees('Team Standup', [{ email: ctx.bob.user.email, name: 'Bob' }]);

            expect(inviteEvent.data!.attendees).toHaveLength(1);
            expect(inviteEvent.data!.attendees![0].email).toBe(ctx.bob.user.email);
            expect(inviteEvent.sequence).toBe(0);

            const bobEvents = await getBobEvents();
            const linked = findOrFail(bobEvents, (e) => e.title === 'Team Standup');
            expect(linked.data!.organizer!.userId).toBe(ctx.alice.user.id);
            expect(linked.data!.organizer!.email).toBe(ctx.alice.user.email);
            expect(linked.data!.organizerEventId).toBe(inviteEvent.id);
        });

        test('linked event is idempotent (no duplicate on re-invite)', async () => {
            const bobEvents = await getBobEvents();
            const linked = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Team Standup');
            expect(linked).toHaveLength(1);
        });

        test('attendee RSVP accepted', async () => {
            const bobEvents = await getBobEvents();
            const linked = findOrFail(bobEvents, (e) => e.title === 'Team Standup');

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
            const aliceRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${Math.floor(Date.now() / 1000) - 86400}/${Math.floor(Date.now() / 1000) + 86400 * 7}`,
            );
            const aliceEvents = await assertJson<CalendarEventOccurrence[]>(aliceRes);
            const orgEvent = findOrFail(aliceEvents, (e) => e.title === 'Team Standup');
            expect(orgEvent.data!.attendees![0].status).toBe('accepted');
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
            const bobEvents = await getBobEvents();
            const linked = findOrFail(bobEvents, (e) => e.title === 'Team Standup');
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

            // Wait for async propagation
            await new Promise((r) => setTimeout(r, 100));

            const bobEvents = await getBobEvents();
            const linked = bobEvents.find((e: CalendarEventOccurrence) => e.title === 'Planning Session v2');
            expect(linked).toBeDefined();
        });
    });

    describe('Cancellation', () => {
        test('organizer delete cancels attendee copies', async () => {
            const event = await createEventWithAttendees('Doomed Meeting', [{ email: ctx.bob.user.email }]);

            // Delete it
            const delRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
                {
                    method: 'DELETE',
                },
            );
            expect(delRes.status).toBe(200);

            // Wait for async propagation
            await new Promise((r) => setTimeout(r, 100));

            const bobEvents = await getBobEvents();
            const linked = bobEvents.find((e: CalendarEventOccurrence) => e.title === 'Doomed Meeting');
            expect(linked).toBeUndefined();
        });

        test('attendee delete declines on organizer', async () => {
            await createEventWithAttendees('Optional Meeting', [{ email: ctx.bob.user.email }]);

            const bobEvents = await getBobEvents();
            const linked = findOrFail(bobEvents, (e) => e.title === 'Optional Meeting');

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

            // Wait for async propagation
            await new Promise((r) => setTimeout(r, 100));

            // Organizer should see declined status
            const from = Math.floor(Date.now() / 1000) - 86400;
            const to = Math.floor(Date.now() / 1000) + 86400 * 7;
            const aliceRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
            );
            const aliceEvents = await assertJson<CalendarEventOccurrence[]>(aliceRes);
            const orgEvent = findOrFail(aliceEvents, (e) => e.title === 'Optional Meeting');
            expect(orgEvent.data!.attendees![0].status).toBe('declined');
        });
    });

    // A re-received invite whose uri a local delete already tombstoned must sync as a fresh 200, not a lone
    // 404 (which deletes the live event on the client), and its row must carry a non-null eventCtag or the
    // sync delta (>eventCtag) never surfaces it at all. Driven at the domain level, like the linked-event
    // seeding in calendar.test.ts — the REST layer has no re-invite-after-delete flow to exercise it.
    describe('Re-received invitation after local delete', () => {
        test('syncs once as a 200 with a non-null eventCtag and no 404 tombstone', async () => {
            const bobHome = await getHome(ctx.bob.user.id);
            const cal = bobHome.calendar;
            const defaultCal = findOrFail(cal.getCalendars(), (c) => c.isDefault);
            const uid = `reinvite-${randomUUID()}`;
            const uri = `${uid}.ics`;
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

            const firstId = cal.receiveInvitation(payload);
            // The client's sync token, captured after the first receive and before the delete + re-receive.
            const preCtag = cal.getCalendarById(defaultCal.id)!.ctag;

            cal.deleteEvent(defaultCal.id, firstId); // Bob deletes his linked copy → tombstones the uri
            const secondId = cal.receiveInvitation(payload); // Alice re-sends the same invite
            expect(secondId).not.toBe(firstId);

            const changed = cal.getChangedEventsSince(defaultCal.id, preCtag).filter((e) => e.uri === uri);
            const deleted = cal.getDeletedEventsSince(defaultCal.id, preCtag).filter((d) => d.uri === uri);
            expect(changed).toHaveLength(1);
            expect(changed[0].eventCtag).not.toBeNull();
            expect(deleted).toHaveLength(0);
        });

        test('a colliding (calendarId, uri) insert fails without a phantom ctag bump', async () => {
            const bobHome = await getHome(ctx.bob.user.id);
            const cal = bobHome.calendar;
            const defaultCal = findOrFail(cal.getCalendars(), (c) => c.isDefault);
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
            cal.receiveInvitation(payload);
            const preCtag = cal.getCalendarById(defaultCal.id)!.ctag;

            // The same uid (→ same uri) under a different organizer key slips past the linked-event dedupe and
            // collides on the (calendarId, uri) unique index. The failure must not leave a phantom ctag bump —
            // every client would poll an empty delta for it.
            expect(() =>
                cal.receiveInvitation({
                    ...payload,
                    organizerEventId: `org-b-${uid}`,
                    organizerUserId: ctx.charlie.user.id,
                }),
            ).toThrow();
            expect(cal.getCalendarById(defaultCal.id)!.ctag).toBe(preCtag);
        });
    });

    describe('Linked event guard', () => {
        test('attendee cannot change title/time on linked event', async () => {
            await createEventWithAttendees('Protected Event', [{ email: ctx.bob.user.email }]);

            const bobEvents = await getBobEvents();
            const linked = findOrFail(bobEvents, (e) => e.title === 'Protected Event');
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

            // Alice should not get a linked copy — only Bob
            const aliceFrom = Math.floor(Date.now() / 1000) - 86400;
            const aliceTo = Math.floor(Date.now() / 1000) + 86400 * 7;
            const aliceRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/event-range/${aliceFrom}/${aliceTo}`,
            );
            const aliceEvents = await assertJson<CalendarEventOccurrence[]>(aliceRes);
            const selfInviteCopies = aliceEvents.filter(
                (e: CalendarEventOccurrence) => e.title === 'Self-Invite Test' && e.data?.organizer,
            );
            expect(selfInviteCopies).toHaveLength(0);

            // Bob should have a linked copy
            const bobEvents = await getBobEvents();
            const bobLinked = bobEvents.find((e: CalendarEventOccurrence) => e.title === 'Self-Invite Test');
            expect(bobLinked).toBeDefined();
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
            await new Promise((r) => setTimeout(r, 100));

            const bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const linked = findOrFail(bobEvents, (e) => e.title === 'Weekly Scoped RSVP');

            const res = await rsvpAs(linked.id, {
                status: 'accepted',
                scope: 'this',
                recurrenceDate: linked.occurrenceDate,
            });
            expect(res.status).toBe(200);

            await new Promise((r) => setTimeout(r, 100));

            // Organizer should see accepted for that occurrence, pending for others
            const aliceEvents = await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id);
            const aliceOccs = aliceEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Scoped RSVP');
            const acceptedOcc = findOrFail(aliceOccs, (e) => e.occurrenceDate === linked.occurrenceDate);
            expect(acceptedOcc.data!.attendees![0].status).toBe('accepted');
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
            await new Promise((r) => setTimeout(r, 100));

            const bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const linked = findOrFail(bobEvents, (e) => e.title === 'Weekly All RSVP');

            const res = await rsvpAs(linked.id, { status: 'accepted' });
            expect(res.status).toBe(200);

            await new Promise((r) => setTimeout(r, 100));

            const aliceEvents = await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id);
            const aliceOccs = aliceEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly All RSVP');
            expect(aliceOccs.every((e: CalendarEventOccurrence) => e.data!.attendees![0].status === 'accepted')).toBe(
                true,
            );
        });

        test('delete scope=this removes one occurrence from attendee, declines on organizer', async () => {
            await createRecurringInvite('Weekly Del This');
            await new Promise((r) => setTimeout(r, 100));

            let bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const linked = findOrFail(bobEvents, (e) => e.title === 'Weekly Del This');
            const targetDate = linked.occurrenceDate;

            const res = await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this',
                recurrenceDate: targetDate,
                remove: true,
            });
            expect(res.status).toBe(200);

            await new Promise((r) => setTimeout(r, 100));

            // Bob no longer sees that occurrence
            bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const bobOccs = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Del This');
            expect(bobOccs.find((e: CalendarEventOccurrence) => e.occurrenceDate === targetDate)).toBeUndefined();
            expect(bobOccs.length).toBe(4); // 5 - 1

            // Organizer sees declined for that date
            const aliceEvents = await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id);
            const aliceOccs = aliceEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Del This');
            const declinedOcc = findOrFail(aliceOccs, (e) => e.occurrenceDate === targetDate);
            expect(declinedOcc.data!.attendees![0].status).toBe('declined');
        });

        test('delete scope=this-and-following removes future from attendee, declines series on organizer', async () => {
            await createRecurringInvite('Weekly Del Following');
            await new Promise((r) => setTimeout(r, 100));

            let bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const bobOccs = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Del Following');
            expect(bobOccs.length).toBe(5);
            // Delete from 2nd occurrence onward
            const secondOcc = bobOccs[1];
            const linked = findOrFail(bobEvents, (e) => e.title === 'Weekly Del Following' && !e.parentEventId);

            const res = await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this-and-following',
                recurrenceDate: secondOcc.occurrenceDate,
                remove: true,
            });
            expect(res.status).toBe(200);

            await new Promise((r) => setTimeout(r, 100));

            // Bob sees only the first occurrence
            bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const remaining = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Del Following');
            expect(remaining.length).toBe(1);
            expect(remaining[0].occurrenceDate).toBe(bobOccs[0].occurrenceDate);

            // Organizer sees declined
            const aliceEvents = await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id);
            const orgEvent = findOrFail(aliceEvents, (e) => e.title === 'Weekly Del Following');
            expect(orgEvent.data!.attendees![0].status).toBe('declined');
        });

        test('organizer truncate does not extend attendee past their own truncation', async () => {
            const event = await createRecurringInvite('Weekly Constrain');
            await new Promise((r) => setTimeout(r, 100));

            let bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const bobOccs = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Constrain');
            expect(bobOccs.length).toBe(5);

            // Bob deletes from 2nd occurrence onward (keeps 1)
            const linked = findOrFail(bobOccs, (e) => !e.parentEventId);
            await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this-and-following',
                recurrenceDate: bobOccs[1].occurrenceDate,
                remove: true,
            });
            await new Promise((r) => setTimeout(r, 100));

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
            await new Promise((r) => setTimeout(r, 100));

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
        let bobCalId: string;
        let linkedId: string;

        async function rangeFor(token: string, ownerId: string) {
            const from = Math.floor(Date.now() / 1000) - 86400;
            const to = Math.floor(Date.now() / 1000) + 86400 * 60;
            return assertJson<CalendarEventOccurrence[]>(
                await authedRequest(token, `/calendar/${ownerId}/event-range/${from}/${to}`),
            );
        }

        async function untilBob(predicate: (e: CalendarEventOccurrence) => boolean) {
            for (let i = 0; i < 60; i++) {
                const found = (await rangeFor(ctx.bob.user.sessionToken, ctx.bob.user.id)).find(predicate);
                if (found) return found;
                await new Promise((r) => setTimeout(r, 50));
            }
            return undefined;
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
                                { email: 'carol.external@example.org', status: 'pending', role: 'required' },
                            ],
                        },
                    }),
                },
            );
            const linked = await untilBob((e) => e.title === 'Fanout Meeting');
            expect(linked).toBeDefined();
            linkedId = linked!.id;
            expect(linked!.sequence).toBe(0);
        });

        test('Bob toggling a reminder does not bump SEQUENCE or send a spoofed iMIP update', async () => {
            const mailer = await import('../lib/core/mailer');
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
            await new Promise((r) => setTimeout(r, 300)); // let any fire-and-forget fan-out run

            expect(updated.sequence).toBe(0); // pre-fix: 1
            const updateMails = spy.mock.calls.filter((c) => c[0].subject === 'Updated invitation: Fanout Meeting');
            expect(updateMails).toHaveLength(0); // pre-fix: an iMIP update to Carol, ORGANIZER=Bob
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
            const renamed = await untilBob((e) => e.id === linkedId && e.title === 'Fanout Meeting V2');
            expect(renamed).toBeDefined(); // pre-fix: dropped by the replay guard (Bob's SEQUENCE had outrun the organizer's)
        });
    });

    // Every write path must hash the etag over the same basis. rsvpForOccurrence used to
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
            const bobEvents = await assertJson<CalendarEventOccurrence[]>(
                await authedRequest(
                    ctx.bob.user.sessionToken,
                    `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
                ),
            );
            linkedMasterId = findOrFail(bobEvents, (e) => e.title === 'Etag Audit').id;

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
});
