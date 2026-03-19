import {beforeAll, describe, expect, test} from 'bun:test';
import {authedRequest, getTestContext} from './setup';

describe('Calendar Timezone', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;
    let bobCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars`);
        const calendars = await res.json() as any[];
        aliceCalendarId = calendars.find((c: any) => c.isDefault)!.id;

        const bobRes = await authedRequest(ctx.bob.user.sessionToken,
            `/calendar/${ctx.bob.user.id}/calendars`);
        const bobCalendars = await bobRes.json() as any[];
        bobCalendarId = bobCalendars.find((c: any) => c.isDefault)!.id;
    });

    async function createEvent(token: string, ownerId: string, calendarId: string, body: Record<string, any>) {
        const res = await authedRequest(token,
            `/calendar/${ownerId}/calendars/${calendarId}/events`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body),
            });
        expect(res.status).toBe(200);
        return await res.json() as any;
    }

    async function getEvents(token: string, ownerId: string, from: number, to: number) {
        const res = await authedRequest(token, `/calendar/${ownerId}/event-range/${from}/${to}`);
        expect(res.status).toBe(200);
        return await res.json() as any[];
    }

    describe('Timezone storage', () => {
        test('create event with timezone stores it', async () => {
            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Amsterdam Meeting',
                startTime: 1741773600,
                endTime: 1741777200,
                allDay: false,
                timezone: 'Europe/Amsterdam',
            });
            expect(event.timezone).toBe('Europe/Amsterdam');
        });

        test('create event without timezone defaults to null', async () => {
            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'No TZ Meeting',
                startTime: 1741773600,
                endTime: 1741777200,
                allDay: false,
            });
            expect(event.timezone).toBeNull();
        });

        test('all-day event has null timezone', async () => {
            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Holiday',
                startTime: 1741737600,
                endTime: 1741824000,
                allDay: true,
                timezone: null,
            });
            expect(event.timezone).toBeNull();
        });

        test('update event preserves timezone when not specified', async () => {
            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ Preserve',
                startTime: 1741773600,
                endTime: 1741777200,
                allDay: false,
                timezone: 'America/New_York',
            });

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({title: 'TZ Preserve Updated'}),
                });
            expect(res.status).toBe(200);
            const updated = await res.json() as any;
            expect(updated.timezone).toBe('America/New_York');
            expect(updated.title).toBe('TZ Preserve Updated');
        });

        test('update event can change timezone', async () => {
            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ Change',
                startTime: 1741773600,
                endTime: 1741777200,
                allDay: false,
                timezone: 'America/New_York',
            });

            const res = await authedRequest(ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({timezone: 'Europe/Amsterdam'}),
                });
            expect(res.status).toBe(200);
            const updated = await res.json() as any;
            expect(updated.timezone).toBe('Europe/Amsterdam');
        });

        test('timezone affects etag', async () => {
            const event1 = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Etag TZ',
                startTime: 1741773600,
                endTime: 1741777200,
                allDay: false,
                timezone: 'Europe/Amsterdam',
            });
            const event2 = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Etag TZ',
                startTime: 1741773600,
                endTime: 1741777200,
                allDay: false,
                timezone: 'America/New_York',
            });
            expect(event1.etag).not.toBe(event2.etag);
        });
    });

    describe('Recurring event DST drift prevention', () => {
        // Monday 2026-03-16 23:30 CET (UTC+1) = 2026-03-16T22:30:00Z
        // After DST switch on 2026-03-29, CEST = UTC+2
        // Without timezone: the UTC time 22:30 stays fixed, so in CEST it becomes 00:30 next day (Tuesday)
        // With timezone: rrule should keep it at 23:30 local time = 21:30 UTC in CEST

        const mondayPreDST = Math.floor(new Date('2026-03-16T22:30:00Z').getTime() / 1000); // 23:30 CET
        const duration = 1800; // 30 min

        test('weekly recurring event at 23:30 Amsterdam stays on Monday after DST switch', async () => {
            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Late Monday CET',
                startTime: mondayPreDST,
                endTime: mondayPreDST + duration,
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
            });
            expect(event.timezone).toBe('Europe/Amsterdam');

            // Query range covering March 16 to April 13 (4 weeks, spanning DST on March 29)
            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: any) => e.title === 'Late Monday CET');

            expect(occurrences.length).toBeGreaterThanOrEqual(4);

            // All occurrences should fall on Monday in Amsterdam time
            for (const occ of occurrences) {
                // rrule with tzid returns UTC dates where the UTC values represent wall-clock time
                // in the specified timezone. So getUTCHours() should be 23 and getUTCDay() should be 1 (Monday)
                const d = new Date(occ.startTime * 1000);
                const utcDay = d.getUTCDay();
                const utcHour = d.getUTCHours();

                // Before DST (CET, UTC+1): 23:30 local = 22:30 UTC → Monday UTC
                // After DST (CEST, UTC+2): 23:30 local = 21:30 UTC → Monday UTC
                // Both cases: the event should be on Monday in UTC
                // (since 21:30 and 22:30 UTC are both still Monday)
                expect(utcDay).toBe(1); // Monday
                expect(utcHour).toBeLessThanOrEqual(22);
                expect(utcHour).toBeGreaterThanOrEqual(21);
            }

            // Verify the first post-DST occurrence shifted from 22:30 UTC to 21:30 UTC
            const preDSTOcc = occurrences.find((e: any) =>
                new Date(e.startTime * 1000).toISOString().startsWith('2026-03-16'));
            expect(preDSTOcc).toBeDefined();

            // Post-DST: 23:30 CEST = 21:30 UTC on March 30
            const postDSTOcc = occurrences.find((e: any) =>
                new Date(e.startTime * 1000).toISOString().startsWith('2026-03-30'));
            expect(postDSTOcc).toBeDefined();

            const preHour = new Date(preDSTOcc.startTime * 1000).getUTCHours();
            const postHour = new Date(postDSTOcc.startTime * 1000).getUTCHours();
            // Pre-DST: 23:30 CET = 22:30 UTC, Post-DST: 23:30 CEST = 21:30 UTC
            expect(preHour).toBe(22);
            expect(postHour).toBe(21);
        });

        test('without timezone, recurring event drifts across DST', async () => {
            // Same event but no timezone — rrule uses UTC, fixed offset
            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Late Monday No TZ',
                startTime: mondayPreDST,
                endTime: mondayPreDST + duration,
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                // no timezone
            });
            expect(event.timezone).toBeNull();

            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: any) => e.title === 'Late Monday No TZ');

            // All occurrences should have the same UTC hour (22:30) since no TZ adjustment
            for (const occ of occurrences) {
                const d = new Date(occ.startTime * 1000);
                expect(d.getUTCHours()).toBe(22);
                expect(d.getUTCMinutes()).toBe(30);
            }
        });

        test('recurring event at 01:00 Amsterdam does not drift to previous day after DST', async () => {
            // Monday 2026-03-16 01:00 CET (UTC+1) = 2026-03-16T00:00:00Z
            // After DST: 01:00 CEST (UTC+2) = 2026-03-30T23:00:00Z on Sunday UTC
            // Key: the LOCAL time should always be 01:00 on Monday, even though UTC day changes
            const earlyMonday = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000); // 01:00 CET

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Early Monday CET',
                startTime: earlyMonday,
                endTime: earlyMonday + 3600,
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
            });

            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: any) => e.title === 'Early Monday CET');

            expect(occurrences.length).toBeGreaterThanOrEqual(4);

            // The local time in Amsterdam should always be 01:00 on Monday
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Europe/Amsterdam', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
            });
            for (const occ of occurrences) {
                const d = new Date(occ.startTime * 1000);
                const utcHour = d.getUTCHours();
                // Pre-DST: 01:00 CET = 00:00 UTC, Post-DST: 01:00 CEST = 23:00 UTC
                expect(utcHour === 0 || utcHour === 23).toBe(true);
                // Verify local time is always Monday 01:00
                const parts = fmt.formatToParts(d);
                const weekday = parts.find(p => p.type === 'weekday')?.value;
                const hour = parts.find(p => p.type === 'hour')?.value;
                expect(weekday).toBe('Mon');
                expect(hour).toBe('01');
            }
        });

        test('US timezone recurring event handles spring forward correctly', async () => {
            // Friday 2026-03-06 17:00 EST (UTC-5) = 2026-03-06T22:00:00Z
            // DST starts March 8, 2026 in US → EDT (UTC-4)
            // After DST: 17:00 EDT = 21:00 UTC
            const fridayEST = Math.floor(new Date('2026-03-06T22:00:00Z').getTime() / 1000);

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Friday US',
                startTime: fridayEST,
                endTime: fridayEST + 3600,
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=FR',
                timezone: 'America/New_York',
            });

            // Query March 2026 (covers DST switch on March 8)
            const from = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: any) => e.title === 'Friday US');

            expect(occurrences.length).toBeGreaterThanOrEqual(3);

            // All should be on Friday at 17:00 in New York
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false,
            });
            for (const occ of occurrences) {
                const d = new Date(occ.startTime * 1000);
                const utcHour = d.getUTCHours();
                // Pre-DST (EST, UTC-5): 17:00 EST = 22:00 UTC Friday
                // Post-DST (EDT, UTC-4): 17:00 EDT = 21:00 UTC Friday
                expect(utcHour === 22 || utcHour === 21).toBe(true);
                expect(d.getUTCDay()).toBe(5); // Friday in UTC too (17:00 NY is always same UTC day)
                // Verify local time
                const parts = fmt.formatToParts(d);
                const weekday = parts.find(p => p.type === 'weekday')?.value;
                const hour = parts.find(p => p.type === 'hour')?.value;
                expect(weekday).toBe('Fri');
                expect(hour).toBe('17');
            }
        });
    });

    describe('Recurring invite with timezone propagation', () => {
        test('invite propagates timezone to attendee', async () => {
            // Monday 2026-03-16 23:30 CET = 22:30 UTC
            const startTime = Math.floor(new Date('2026-03-16T22:30:00Z').getTime() / 1000);

            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ Invite Weekly',
                startTime,
                endTime: startTime + 1800,
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
                data: {
                    attendees: [{email: ctx.bob.user.email, name: 'Bob', status: 'pending', role: 'required'}],
                },
            });
            expect(event.timezone).toBe('Europe/Amsterdam');

            // Check Bob's linked event has the timezone
            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            const bobEvents = await getEvents(ctx.bob.user.sessionToken, ctx.bob.user.id, from, to);
            const linked = bobEvents.find((e: any) => e.title === 'TZ Invite Weekly');
            expect(linked).toBeDefined();
            expect(linked.timezone).toBe('Europe/Amsterdam');
        });

        test('recurring invite expands correctly across DST for attendee', async () => {
            // Use a different time to avoid collision with previous test events
            // Monday 2026-03-16 22:00 CET = 21:00 UTC
            const startTime = Math.floor(new Date('2026-03-16T21:00:00Z').getTime() / 1000);

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ Invite DST Check',
                startTime,
                endTime: startTime + 3600,
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
                data: {
                    attendees: [{email: ctx.bob.user.email, name: 'Bob', status: 'pending', role: 'required'}],
                },
            });

            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            // Bob's expanded occurrences should also respect the timezone
            const bobEvents = await getEvents(ctx.bob.user.sessionToken, ctx.bob.user.id, from, to);
            const occurrences = bobEvents.filter((e: any) => e.title === 'TZ Invite DST Check');

            expect(occurrences.length).toBeGreaterThanOrEqual(4);

            // All should be on Monday
            for (const occ of occurrences) {
                const d = new Date(occ.startTime * 1000);
                // Before DST: 21:00 UTC Monday, After DST: 20:00 UTC Monday
                expect(d.getUTCDay()).toBe(1); // Monday
            }
        });
    });

    describe('computeOccurrenceTimes with timezone', () => {
        test('rsvp for occurrence uses timezone-aware expansion', async () => {
            // Create a recurring event with timezone, then RSVP for a post-DST occurrence
            const startTime = Math.floor(new Date('2026-03-16T22:30:00Z').getTime() / 1000);

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ RSVP Test',
                startTime,
                endTime: startTime + 1800,
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
                data: {
                    attendees: [{email: ctx.bob.user.email, name: 'Bob', status: 'pending', role: 'required'}],
                },
            });

            // RSVP for a post-DST occurrence (April 6, 2026 is a Monday)
            const bobFrom = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const bobTo = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);
            const bobEvents = await getEvents(ctx.bob.user.sessionToken, ctx.bob.user.id, bobFrom, bobTo);
            const linkedParent = bobEvents.find((e: any) => e.title === 'TZ RSVP Test');
            expect(linkedParent).toBeDefined();

            // Find a post-DST occurrence (after March 29)
            const postDSTOcc = bobEvents.find((e: any) =>
                e.title === 'TZ RSVP Test' && e.startTime > Math.floor(new Date('2026-03-29T00:00:00Z').getTime() / 1000)
            );

            if (postDSTOcc) {
                // RSVP for this occurrence
                const rsvpRes = await authedRequest(ctx.bob.user.sessionToken,
                    `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events/${linkedParent.id}/rsvp`, {
                        method: 'PUT',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            status: 'accepted',
                            scope: 'this',
                            recurrenceDate: postDSTOcc.occurrenceDate,
                        }),
                    });
                expect(rsvpRes.status).toBe(200);

                // Verify the exception was created with correct times
                const afterEvents = await getEvents(ctx.bob.user.sessionToken, ctx.bob.user.id, bobFrom, bobTo);
                const exception = afterEvents.find((e: any) =>
                    e.title === 'TZ RSVP Test' && e.occurrenceDate === postDSTOcc.occurrenceDate
                );
                expect(exception).toBeDefined();

                // The exception's start time should match the post-DST occurrence time
                const excDate = new Date(exception.startTime * 1000);
                expect(excDate.getUTCDay()).toBe(1); // Monday
                // Post-DST: 23:30 CEST = 21:30 UTC
                expect(excDate.getUTCHours()).toBe(21);
                expect(excDate.getUTCMinutes()).toBe(30);
            }
        });

        test('cancel occurrence of timezone-aware recurring event', async () => {
            const startTime = Math.floor(new Date('2026-03-16T22:30:00Z').getTime() / 1000);

            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ Cancel Occ',
                startTime,
                endTime: startTime + 1800,
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
            });

            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: any) => e.title === 'TZ Cancel Occ');
            const postDSTOcc = occurrences.find((e: any) =>
                e.startTime > Math.floor(new Date('2026-03-29T00:00:00Z').getTime() / 1000)
            );

            if (postDSTOcc) {
                // Cancel the post-DST occurrence
                await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                    title: 'TZ Cancel Occ',
                    startTime: postDSTOcc.startTime,
                    endTime: postDSTOcc.endTime,
                    allDay: false,
                    parentEventId: event.id,
                    recurrenceDate: postDSTOcc.occurrenceDate,
                    status: 'cancelled',
                });

                // Verify it's gone
                const afterEvents = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
                const afterOccs = afterEvents.filter((e: any) =>
                    e.title === 'TZ Cancel Occ' && e.occurrenceDate === postDSTOcc.occurrenceDate && !e.parentEventId);
                expect(afterOccs.length).toBe(0);

                // Other occurrences still present
                const remainingOccs = afterEvents.filter((e: any) =>
                    e.title === 'TZ Cancel Occ' && !e.parentEventId);
                expect(remainingOccs.length).toBe(occurrences.length - 1);
            }
        });
    });

    describe('Events in range with timezone', () => {
        test('timezone-aware recurring events appear in range query', async () => {
            // Create event at 23:30 Amsterdam (22:30 UTC pre-DST)
            const startTime = Math.floor(new Date('2026-03-16T22:30:00Z').getTime() / 1000);

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ Range Test',
                startTime,
                endTime: startTime + 1800,
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5',
                timezone: 'Europe/Amsterdam',
            });

            // Query a range that covers all 5 occurrences
            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-20T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: any) => e.title === 'TZ Range Test');
            expect(occurrences.length).toBe(5);
        });

        test('old events without timezone still work (backward compat)', async () => {
            // Event without timezone — should behave exactly like before
            const startTime = Math.floor(new Date('2026-03-16T22:30:00Z').getTime() / 1000);

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'No TZ Compat',
                startTime,
                endTime: startTime + 1800,
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
            });

            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-10T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: any) => e.title === 'No TZ Compat');
            expect(occurrences.length).toBe(3);

            // All at same UTC hour (no DST adjustment)
            for (const occ of occurrences) {
                const d = new Date(occ.startTime * 1000);
                expect(d.getUTCHours()).toBe(22);
                expect(d.getUTCMinutes()).toBe(30);
            }
        });
    });
});
