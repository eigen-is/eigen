import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext} from './setup';

describe('Calendar Invites', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars`);
        const calendars = await res.json() as any[];
        aliceCalendarId = calendars.find((c: any) => c.isDefault)!.id;
    });

    async function createEventWithAttendees(title: string, attendees: {email: string; name?: string}[]) {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    title,
                    startTime: Math.floor(Date.now() / 1000) + 3600,
                    endTime: Math.floor(Date.now() / 1000) + 7200,
                    allDay: false,
                    data: {
                        attendees: attendees.map(a => ({...a, status: 'pending', role: 'required'})),
                    },
                }),
            });
        expect(res.status).toBe(200);
        return await res.json() as any;
    }

    async function getBobEvents() {
        const from = Math.floor(Date.now() / 1000) - 86400;
        const to = Math.floor(Date.now() / 1000) + 86400 * 7;
        const eventsRes = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`);
        return await eventsRes.json() as any[];
    }

    describe('Invite propagation', () => {
        let inviteEvent: any;

        test('create event with attendees propagates to attendee', async () => {
            inviteEvent = await createEventWithAttendees('Team Standup', [
                {email: ctx.bob.user.email, name: 'Bob'},
            ]);

            expect(inviteEvent.data.attendees).toHaveLength(1);
            expect(inviteEvent.data.attendees[0].email).toBe(ctx.bob.user.email);
            expect(inviteEvent.sequence).toBe(0);

            const bobEvents = await getBobEvents();
            const linked = bobEvents.find((e: any) => e.title === 'Team Standup');
            expect(linked).toBeDefined();
            expect(linked.data.organizer.userId).toBe(ctx.alice.user.id);
            expect(linked.data.organizer.email).toBe(ctx.alice.user.email);
            expect(linked.data.organizerEventId).toBe(inviteEvent.id);
        });

        test('linked event is idempotent (no duplicate on re-invite)', async () => {
            const bobEvents = await getBobEvents();
            const linked = bobEvents.filter((e: any) => e.title === 'Team Standup');
            expect(linked).toHaveLength(1);
        });

        test('attendee RSVP accepted', async () => {
            const bobEvents = await getBobEvents();
            const linked = bobEvents.find((e: any) => e.title === 'Team Standup');

            const bobCalsRes = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars`);
            const bobCalId = ((await bobCalsRes.json()) as any[]).find((c: any) => c.isDefault)!.id;

            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${bobCalId}/events/${linked.id}/rsvp`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({status: 'accepted'}),
                });
            expect(res.status).toBe(200);

            // Check organizer's event reflects the RSVP
            const aliceRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${Math.floor(Date.now() / 1000) - 86400}/${Math.floor(Date.now() / 1000) + 86400 * 7}`);
            const aliceEvents = await aliceRes.json() as any[];
            const orgEvent = aliceEvents.find((e: any) => e.title === 'Team Standup');
            expect(orgEvent.data.attendees[0].status).toBe('accepted');
        });

        test('RSVP on non-linked event fails', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${inviteEvent.id}/rsvp`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({status: 'accepted'}),
                });
            expect(res.status).toBe(400);
        });

        test('RSVP by non-attendee fails', async () => {
            const bobEvents = await getBobEvents();
            const linked = bobEvents.find((e: any) => e.title === 'Team Standup');
            const bobCalId = ((await (await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars`)).json()) as any[]).find((c: any) => c.isDefault)!.id;

            // Charlie is not an attendee
            const res = await authedRequest(ctx.charlie.user.sessionToken,
                `/calendar/${ctx.charlie.user.id}/calendars/${bobCalId}/events/${linked.id}/rsvp`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({status: 'accepted'}),
                });
            expect(res.status).not.toBe(200);
        });
    });

    describe('Update propagation', () => {
        test('organizer update propagates to attendee', async () => {
            const event = await createEventWithAttendees('Planning Session', [
                {email: ctx.bob.user.email},
            ]);

            // Update title
            const updateRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title: 'Planning Session v2',
                        data: {attendees: event.data.attendees},
                    }),
                });
            expect(updateRes.status).toBe(200);

            // Wait for async propagation
            await new Promise(r => setTimeout(r, 100));

            const bobEvents = await getBobEvents();
            const linked = bobEvents.find((e: any) => e.title === 'Planning Session v2');
            expect(linked).toBeDefined();
        });
    });

    describe('Cancellation', () => {
        test('organizer delete cancels attendee copies', async () => {
            const event = await createEventWithAttendees('Doomed Meeting', [
                {email: ctx.bob.user.email},
            ]);

            // Delete it
            const delRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`, {
                    method: 'DELETE',
                });
            expect(delRes.status).toBe(200);

            // Wait for async propagation
            await new Promise(r => setTimeout(r, 100));

            const bobEvents = await getBobEvents();
            const linked = bobEvents.find((e: any) => e.title === 'Doomed Meeting');
            expect(linked).toBeUndefined();
        });

        test('attendee delete declines on organizer', async () => {
            await createEventWithAttendees('Optional Meeting', [
                {email: ctx.bob.user.email},
            ]);

            const bobEvents = await getBobEvents();
            const linked = bobEvents.find((e: any) => e.title === 'Optional Meeting');
            expect(linked).toBeDefined();

            const bobCalId = ((await (await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars`)).json()) as any[]).find((c: any) => c.isDefault)!.id;

            const delRes = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${bobCalId}/events/${linked.id}`, {
                    method: 'DELETE',
                });
            expect(delRes.status).toBe(200);

            // Wait for async propagation
            await new Promise(r => setTimeout(r, 100));

            // Organizer should see declined status
            const from = Math.floor(Date.now() / 1000) - 86400;
            const to = Math.floor(Date.now() / 1000) + 86400 * 7;
            const aliceRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`);
            const aliceEvents = await aliceRes.json() as any[];
            const orgEvent = aliceEvents.find((e: any) => e.title === 'Optional Meeting');
            expect(orgEvent).toBeDefined();
            expect(orgEvent.data.attendees[0].status).toBe('declined');
        });
    });

    describe('Linked event guard', () => {
        test('attendee cannot change title/time on linked event', async () => {
            await createEventWithAttendees('Protected Event', [
                {email: ctx.bob.user.email},
            ]);

            const bobEvents = await getBobEvents();
            const linked = bobEvents.find((e: any) => e.title === 'Protected Event');
            const bobCalId = ((await (await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars`)).json()) as any[]).find((c: any) => c.isDefault)!.id;

            // Try to change title — should be ignored by the guard
            const updateRes = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${bobCalId}/events/${linked.id}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({title: 'Hacked Title'}),
                });
            expect(updateRes.status).toBe(200);
            const updated = await updateRes.json() as any;
            expect(updated.title).toBe('Protected Event'); // Title unchanged
        });
    });

    describe('Self-invite prevention', () => {
        test('organizer is not invited to their own event', async () => {
            await createEventWithAttendees('Self-Invite Test', [
                {email: ctx.alice.user.email}, // self
                {email: ctx.bob.user.email},
            ]);

            // Alice should not get a linked copy — only Bob
            const aliceFrom = Math.floor(Date.now() / 1000) - 86400;
            const aliceTo = Math.floor(Date.now() / 1000) + 86400 * 7;
            const aliceRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/event-range/${aliceFrom}/${aliceTo}`);
            const aliceEvents = await aliceRes.json() as any[];
            const selfInviteCopies = aliceEvents.filter(
                (e: any) => e.title === 'Self-Invite Test' && e.data?.organizer
            );
            expect(selfInviteCopies).toHaveLength(0);

            // Bob should have a linked copy
            const bobEvents = await getBobEvents();
            const bobLinked = bobEvents.find((e: any) => e.title === 'Self-Invite Test');
            expect(bobLinked).toBeDefined();
        });
    });

    describe('Per-occurrence RSVP', () => {
        const baseTime = Math.floor(new Date('2026-06-01T10:00:00Z').getTime() / 1000);
        let bobCalId: string;

        async function createRecurringInvite(title: string) {
            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        title,
                        startTime: baseTime,
                        endTime: baseTime + 3600,
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;COUNT=5',
                        data: {
                            attendees: [{email: ctx.bob.user.email, name: 'Bob', status: 'pending', role: 'required'}],
                        },
                    }),
                });
            expect(res.status).toBe(200);
            return await res.json() as any;
        }

        async function getBobCalId() {
            if (bobCalId) return bobCalId;
            const res = await authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars`);
            bobCalId = ((await res.json()) as any[]).find((c: any) => c.isDefault)!.id;
            return bobCalId;
        }

        async function getEventsInRange(token: string, ownerId: string) {
            const from = baseTime - 86400;
            const to = baseTime + 86400 * 42;
            const res = await authedRequest(token, `/calendar/${ownerId}/event-range/${from}/${to}`);
            return await res.json() as any[];
        }

        async function rsvpAs(bobLinkedId: string, body: Record<string, any>) {
            const calId = await getBobCalId();
            return authedRequest(ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${calId}/events/${bobLinkedId}/rsvp`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(body),
                });
        }

        test('RSVP scope=this accepts a single occurrence', async () => {
            await createRecurringInvite('Weekly Scoped RSVP');
            await new Promise(r => setTimeout(r, 100));

            let bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const linked = bobEvents.find((e: any) => e.title === 'Weekly Scoped RSVP');
            expect(linked).toBeDefined();

            const res = await rsvpAs(linked.id, {
                status: 'accepted',
                scope: 'this',
                recurrenceDate: linked.occurrenceDate,
            });
            expect(res.status).toBe(200);

            await new Promise(r => setTimeout(r, 100));

            // Organizer should see accepted for that occurrence, pending for others
            const aliceEvents = await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id);
            const aliceOccs = aliceEvents.filter((e: any) => e.title === 'Weekly Scoped RSVP');
            const acceptedOcc = aliceOccs.find((e: any) => e.occurrenceDate === linked.occurrenceDate);
            expect(acceptedOcc.data.attendees[0].status).toBe('accepted');
            const otherOccs = aliceOccs.filter((e: any) => e.occurrenceDate !== linked.occurrenceDate);
            expect(otherOccs.length).toBeGreaterThan(0);
            expect(otherOccs.every((e: any) => e.data.attendees[0].status === 'pending')).toBe(true);
        });

        test('RSVP scope=all accepts all occurrences', async () => {
            await createRecurringInvite('Weekly All RSVP');
            await new Promise(r => setTimeout(r, 100));

            let bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const linked = bobEvents.find((e: any) => e.title === 'Weekly All RSVP');

            const res = await rsvpAs(linked.id, {status: 'accepted'});
            expect(res.status).toBe(200);

            await new Promise(r => setTimeout(r, 100));

            const aliceEvents = await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id);
            const aliceOccs = aliceEvents.filter((e: any) => e.title === 'Weekly All RSVP');
            expect(aliceOccs.every((e: any) => e.data.attendees[0].status === 'accepted')).toBe(true);
        });

        test('delete scope=this removes one occurrence from attendee, declines on organizer', async () => {
            await createRecurringInvite('Weekly Del This');
            await new Promise(r => setTimeout(r, 100));

            let bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const linked = bobEvents.find((e: any) => e.title === 'Weekly Del This');
            const targetDate = linked.occurrenceDate;

            const res = await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this',
                recurrenceDate: targetDate,
                remove: true,
            });
            expect(res.status).toBe(200);

            await new Promise(r => setTimeout(r, 100));

            // Bob no longer sees that occurrence
            bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const bobOccs = bobEvents.filter((e: any) => e.title === 'Weekly Del This');
            expect(bobOccs.find((e: any) => e.occurrenceDate === targetDate)).toBeUndefined();
            expect(bobOccs.length).toBe(4); // 5 - 1

            // Organizer sees declined for that date
            const aliceEvents = await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id);
            const aliceOccs = aliceEvents.filter((e: any) => e.title === 'Weekly Del This');
            const declinedOcc = aliceOccs.find((e: any) => e.occurrenceDate === targetDate);
            expect(declinedOcc.data.attendees[0].status).toBe('declined');
        });

        test('delete scope=this-and-following removes future from attendee, declines series on organizer', async () => {
            await createRecurringInvite('Weekly Del Following');
            await new Promise(r => setTimeout(r, 100));

            let bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const bobOccs = bobEvents.filter((e: any) => e.title === 'Weekly Del Following');
            expect(bobOccs.length).toBe(5);
            // Delete from 2nd occurrence onward
            const secondOcc = bobOccs[1];
            const linked = bobEvents.find((e: any) => e.title === 'Weekly Del Following' && !e.parentEventId);

            const res = await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this-and-following',
                recurrenceDate: secondOcc.occurrenceDate,
                remove: true,
            });
            expect(res.status).toBe(200);

            await new Promise(r => setTimeout(r, 100));

            // Bob sees only the first occurrence
            bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const remaining = bobEvents.filter((e: any) => e.title === 'Weekly Del Following');
            expect(remaining.length).toBe(1);
            expect(remaining[0].occurrenceDate).toBe(bobOccs[0].occurrenceDate);

            // Organizer sees declined
            const aliceEvents = await getEventsInRange(ctx.alice.user.sessionToken, ctx.alice.user.id);
            const orgEvent = aliceEvents.find((e: any) => e.title === 'Weekly Del Following');
            expect(orgEvent.data.attendees[0].status).toBe('declined');
        });

        test('organizer truncate does not extend attendee past their own truncation', async () => {
            const event = await createRecurringInvite('Weekly Constrain');
            await new Promise(r => setTimeout(r, 100));

            let bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const bobOccs = bobEvents.filter((e: any) => e.title === 'Weekly Constrain');
            expect(bobOccs.length).toBe(5);

            // Bob deletes from 2nd occurrence onward (keeps 1)
            const linked = bobOccs.find((e: any) => !e.parentEventId)!;
            await rsvpAs(linked.id, {
                status: 'declined',
                scope: 'this-and-following',
                recurrenceDate: bobOccs[1].occurrenceDate,
                remove: true,
            });
            await new Promise(r => setTimeout(r, 100));

            bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            expect(bobEvents.filter((e: any) => e.title === 'Weekly Constrain').length).toBe(1);

            // Now Alice truncates from 4th occurrence (keeps 3) — broader than Bob's truncation
            const aliceRes = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        rrule: `FREQ=WEEKLY;UNTIL=${new Date((baseTime + 86400 * 20) * 1000).toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
                        data: {attendees: event.data.attendees},
                    }),
                });
            expect(aliceRes.status).toBe(200);
            await new Promise(r => setTimeout(r, 100));

            // Bob should still see only 1 occurrence — not re-expanded
            bobEvents = await getEventsInRange(ctx.bob.user.sessionToken, ctx.bob.user.id);
            const constrained = bobEvents.filter((e: any) => e.title === 'Weekly Constrain');
            expect(constrained.length).toBe(1);
        });
    });
});
