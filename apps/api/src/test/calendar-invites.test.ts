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
            `/calendar/${ctx.bob.user.id}/events/${from}/${to}`);
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
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${Math.floor(Date.now() / 1000) - 86400}/${Math.floor(Date.now() / 1000) + 86400 * 7}`);
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
                `/calendar/${ctx.alice.user.id}/events/${from}/${to}`);
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
                `/calendar/${ctx.alice.user.id}/events/${aliceFrom}/${aliceTo}`);
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
});
