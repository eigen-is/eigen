import { beforeAll, describe, expect, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, CalendarItem } from '@workspace/lib/types/calendar';
import { assertJson, authedRequest, findOrFail, getTestContext } from './setup';

describe('Calendar Timezone', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;
    let bobCalendarId: string;

    beforeAll(async () => {
        ctx = await getTestContext();

        const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
        const calendars = await assertJson<CalendarItem[]>(res);
        aliceCalendarId = findOrFail(calendars, (c) => c.isDefault).id;

        const bobRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`);
        const bobCalendars = await assertJson<CalendarItem[]>(bobRes);
        bobCalendarId = findOrFail(bobCalendars, (c) => c.isDefault).id;
    });

    async function createEvent(token: string, ownerId: string, calendarId: string, body: Record<string, unknown>) {
        const res = await authedRequest(token, `/calendar/${ownerId}/calendars/${calendarId}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return assertJson<CalendarEvent>(res);
    }

    async function getEvents(token: string, ownerId: string, from: number, to: number) {
        const res = await authedRequest(token, `/calendar/${ownerId}/event-range/${from}/${to}`);
        return assertJson<CalendarEventOccurrence[]>(res);
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

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'TZ Preserve Updated' }),
                },
            );
            const updated = await assertJson<CalendarEvent>(res);
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

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ timezone: 'Europe/Amsterdam' }),
                },
            );
            const updated = await assertJson<CalendarEvent>(res);
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

        const mondayPreDST = new Date('2026-03-16T22:30:00Z'); // 23:30 CET
        const durationMs = 1800_000; // 30 min

        test('weekly recurring event at 23:30 Amsterdam stays on Monday after DST switch', async () => {
            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Late Monday CET',
                startTime: mondayPreDST,
                endTime: new Date(mondayPreDST.getTime() + durationMs),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
            });
            expect(event.timezone).toBe('Europe/Amsterdam');

            // Query range covering March 16 to April 13 (4 weeks, spanning DST on March 29)
            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: CalendarEventOccurrence) => e.title === 'Late Monday CET');

            expect(occurrences.length).toBeGreaterThanOrEqual(4);

            // All occurrences should fall on Monday in Amsterdam time
            for (const occ of occurrences) {
                // rrule with tzid returns UTC dates where the UTC values represent wall-clock time
                // in the specified timezone. So getUTCHours() should be 23 and getUTCDay() should be 1 (Monday)
                const d = new Date(occ.startTime);
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
            const preDSTOcc = findOrFail(occurrences, (e) =>
                new Date(e.startTime).toISOString().startsWith('2026-03-16'),
            );

            // Post-DST: 23:30 CEST = 21:30 UTC on March 30
            const postDSTOcc = findOrFail(occurrences, (e) =>
                new Date(e.startTime).toISOString().startsWith('2026-03-30'),
            );

            const preHour = new Date(preDSTOcc.startTime).getUTCHours();
            const postHour = new Date(postDSTOcc.startTime).getUTCHours();
            // Pre-DST: 23:30 CET = 22:30 UTC, Post-DST: 23:30 CEST = 21:30 UTC
            expect(preHour).toBe(22);
            expect(postHour).toBe(21);
        });

        test('weekly recurring event at 23:30 Amsterdam is not dropped on the DST fall-back Sunday', async () => {
            // Sunday 2025-09-14 23:30 CEST (UTC+2) = 21:30Z. The last Sunday of October (2025-10-26)
            // is the EU fall-back day (25-hour local day): 23:30 CET = 22:30Z.
            const sundayStart = new Date('2025-09-14T21:30:00Z');

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Late Sunday Fall-Back',
                startTime: sundayStart,
                endTime: new Date(sundayStart.getTime() + durationMs),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=SU',
                timezone: 'Europe/Amsterdam',
            });

            // Month-view-like query covering all of October 2025
            const from = Math.floor(new Date('2025-09-29T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2025-11-03T00:00:00Z').getTime() / 1000);
            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: CalendarEventOccurrence) => e.title === 'Late Sunday Fall-Back');

            const starts = occurrences.map((e) => new Date(e.startTime).toISOString());
            expect(starts).toContain('2025-10-19T21:30:00.000Z'); // 23:30 CEST
            expect(starts).toContain('2025-10-26T22:30:00.000Z'); // 23:30 CET, fall-back day
            expect(starts).toContain('2025-11-02T22:30:00.000Z'); // 23:30 CET
            const fallBack = findOrFail(occurrences, (e) => e.occurrenceDate === '2025-10-26');
            expect(new Date(fallBack.startTime).toISOString()).toBe('2025-10-26T22:30:00.000Z');

            // Week-view-like query of just the fall-back week
            const weekFrom = Math.floor(new Date('2025-10-20T00:00:00Z').getTime() / 1000);
            const weekTo = Math.floor(new Date('2025-10-27T00:00:00Z').getTime() / 1000);
            const weekEvents = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, weekFrom, weekTo);
            const weekOccs = weekEvents.filter((e: CalendarEventOccurrence) => e.title === 'Late Sunday Fall-Back');
            expect(weekOccs.map((e) => e.occurrenceDate)).toEqual(['2025-10-26']);

            // The series recurs forever, so next year's fall-back Sunday (2026-10-25) must expand too
            const nextFrom = Math.floor(new Date('2026-10-19T00:00:00Z').getTime() / 1000);
            const nextTo = Math.floor(new Date('2026-11-04T00:00:00Z').getTime() / 1000);
            const nextEvents = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, nextFrom, nextTo);
            const nextStarts = nextEvents
                .filter((e: CalendarEventOccurrence) => e.title === 'Late Sunday Fall-Back')
                .map((e) => new Date(e.startTime).toISOString());
            expect(nextStarts).toContain('2026-10-25T22:30:00.000Z');
        });

        test('without timezone, recurring event drifts across DST', async () => {
            // Same event but no timezone — rrule uses UTC, fixed offset
            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Late Monday No TZ',
                startTime: mondayPreDST,
                endTime: new Date(mondayPreDST.getTime() + durationMs),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                // no timezone
            });
            expect(event.timezone).toBeNull();

            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: CalendarEventOccurrence) => e.title === 'Late Monday No TZ');

            // All occurrences should have the same UTC hour (22:30) since no TZ adjustment
            for (const occ of occurrences) {
                const d = new Date(occ.startTime);
                expect(d.getUTCHours()).toBe(22);
                expect(d.getUTCMinutes()).toBe(30);
            }
        });

        test('recurring event at 01:00 Amsterdam does not drift to previous day after DST', async () => {
            // Monday 2026-03-16 01:00 CET (UTC+1) = 2026-03-16T00:00:00Z
            // After DST: 01:00 CEST (UTC+2) = 2026-03-30T23:00:00Z on Sunday UTC
            // Key: the LOCAL time should always be 01:00 on Monday, even though UTC day changes
            const earlyMonday = new Date('2026-03-16T00:00:00Z'); // 01:00 CET

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Early Monday CET',
                startTime: earlyMonday,
                endTime: new Date(earlyMonday.getTime() + 3600_000),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
            });

            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: CalendarEventOccurrence) => e.title === 'Early Monday CET');

            expect(occurrences.length).toBeGreaterThanOrEqual(4);

            // The local time in Amsterdam should always be 01:00 on Monday
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: 'Europe/Amsterdam',
                weekday: 'short',
                hour: 'numeric',
                minute: 'numeric',
                hour12: false,
            });
            for (const occ of occurrences) {
                const d = new Date(occ.startTime);
                const utcHour = d.getUTCHours();
                // Pre-DST: 01:00 CET = 00:00 UTC, Post-DST: 01:00 CEST = 23:00 UTC
                expect(utcHour === 0 || utcHour === 23).toBe(true);
                // Verify local time is always Monday 01:00
                const parts = fmt.formatToParts(d);
                const weekday = parts.find((p) => p.type === 'weekday')?.value;
                const hour = parts.find((p) => p.type === 'hour')?.value;
                expect(weekday).toBe('Mon');
                expect(hour).toBe('01');
            }
        });

        test('US timezone recurring event handles spring forward correctly', async () => {
            // Friday 2026-03-06 17:00 EST (UTC-5) = 2026-03-06T22:00:00Z
            // DST starts March 8, 2026 in US → EDT (UTC-4)
            // After DST: 17:00 EDT = 21:00 UTC
            const fridayEST = new Date('2026-03-06T22:00:00Z');

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'Friday US',
                startTime: fridayEST,
                endTime: new Date(fridayEST.getTime() + 3600_000),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=FR',
                timezone: 'America/New_York',
            });

            // Query March 2026 (covers DST switch on March 8)
            const from = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: CalendarEventOccurrence) => e.title === 'Friday US');

            expect(occurrences.length).toBeGreaterThanOrEqual(3);

            // All should be on Friday at 17:00 in New York
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                weekday: 'short',
                hour: 'numeric',
                hour12: false,
            });
            for (const occ of occurrences) {
                const d = new Date(occ.startTime);
                const utcHour = d.getUTCHours();
                // Pre-DST (EST, UTC-5): 17:00 EST = 22:00 UTC Friday
                // Post-DST (EDT, UTC-4): 17:00 EDT = 21:00 UTC Friday
                expect(utcHour === 22 || utcHour === 21).toBe(true);
                expect(d.getUTCDay()).toBe(5); // Friday in UTC too (17:00 NY is always same UTC day)
                // Verify local time
                const parts = fmt.formatToParts(d);
                const weekday = parts.find((p) => p.type === 'weekday')?.value;
                const hour = parts.find((p) => p.type === 'hour')?.value;
                expect(weekday).toBe('Fri');
                expect(hour).toBe('17');
            }
        });
    });

    describe('Recurring invite with timezone propagation', () => {
        test('invite propagates timezone to attendee', async () => {
            // Monday 2026-03-16 23:30 CET = 22:30 UTC
            const startTime = new Date('2026-03-16T22:30:00Z');

            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ Invite Weekly',
                startTime,
                endTime: new Date(startTime.getTime() + 1800_000),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
                data: {
                    attendees: [{ email: ctx.bob.user.email, name: 'Bob', status: 'pending', role: 'required' }],
                },
            });
            expect(event.timezone).toBe('Europe/Amsterdam');

            // Check Bob's linked event has the timezone
            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            const bobEvents = await getEvents(ctx.bob.user.sessionToken, ctx.bob.user.id, from, to);
            const linked = findOrFail(bobEvents, (e) => e.title === 'TZ Invite Weekly');
            expect(linked.timezone).toBe('Europe/Amsterdam');
        });

        test('recurring invite expands correctly across DST for attendee', async () => {
            // Use a different time to avoid collision with previous test events
            // Monday 2026-03-16 22:00 CET = 21:00 UTC
            const startTime = new Date('2026-03-16T21:00:00Z');

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ Invite DST Check',
                startTime,
                endTime: new Date(startTime.getTime() + 3600_000),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
                data: {
                    attendees: [{ email: ctx.bob.user.email, name: 'Bob', status: 'pending', role: 'required' }],
                },
            });

            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            // Bob's expanded occurrences should also respect the timezone
            const bobEvents = await getEvents(ctx.bob.user.sessionToken, ctx.bob.user.id, from, to);
            const occurrences = bobEvents.filter((e: CalendarEventOccurrence) => e.title === 'TZ Invite DST Check');

            expect(occurrences.length).toBeGreaterThanOrEqual(4);

            // All should be on Monday
            for (const occ of occurrences) {
                const d = new Date(occ.startTime);
                // Before DST: 21:00 UTC Monday, After DST: 20:00 UTC Monday
                expect(d.getUTCDay()).toBe(1); // Monday
            }
        });
    });

    describe('computeOccurrenceTimes with timezone', () => {
        test('rsvp for occurrence uses timezone-aware expansion', async () => {
            // Create a recurring event with timezone, then RSVP for a post-DST occurrence
            const startTime = new Date('2026-03-16T22:30:00Z');

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ RSVP Test',
                startTime,
                endTime: new Date(startTime.getTime() + 1800_000),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
                data: {
                    attendees: [{ email: ctx.bob.user.email, name: 'Bob', status: 'pending', role: 'required' }],
                },
            });

            // RSVP for a post-DST occurrence (April 6, 2026 is a Monday)
            const bobFrom = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const bobTo = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);
            const bobEvents = await getEvents(ctx.bob.user.sessionToken, ctx.bob.user.id, bobFrom, bobTo);
            const linkedParent = findOrFail(bobEvents, (e) => e.title === 'TZ RSVP Test');

            // Find a post-DST occurrence (after March 29)
            const postDSTOcc = bobEvents.find(
                (e: CalendarEventOccurrence) =>
                    e.title === 'TZ RSVP Test' && new Date(e.startTime) > new Date('2026-03-29T00:00:00Z'),
            );

            if (postDSTOcc) {
                // RSVP for this occurrence
                const rsvpRes = await authedRequest(
                    ctx.bob.user.sessionToken,
                    `/calendar/${ctx.bob.user.id}/calendars/${bobCalendarId}/events/${linkedParent.id}/rsvp`,
                    {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            status: 'accepted',
                            scope: 'this',
                            recurrenceDate: postDSTOcc.occurrenceDate,
                        }),
                    },
                );
                expect(rsvpRes.status).toBe(200);

                // Verify the exception was created with correct times
                const afterEvents = await getEvents(ctx.bob.user.sessionToken, ctx.bob.user.id, bobFrom, bobTo);
                const exception = findOrFail(
                    afterEvents,
                    (e) => e.title === 'TZ RSVP Test' && e.occurrenceDate === postDSTOcc.occurrenceDate,
                );

                // The exception's start time should match the post-DST occurrence time
                const excDate = new Date(exception.startTime);
                expect(excDate.getUTCDay()).toBe(1); // Monday
                // Post-DST: 23:30 CEST = 21:30 UTC
                expect(excDate.getUTCHours()).toBe(21);
                expect(excDate.getUTCMinutes()).toBe(30);
            }
        });

        test('cancel occurrence of timezone-aware recurring event', async () => {
            const startTime = new Date('2026-03-16T22:30:00Z');

            const event = await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ Cancel Occ',
                startTime,
                endTime: new Date(startTime.getTime() + 1800_000),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO',
                timezone: 'Europe/Amsterdam',
            });

            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-14T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: CalendarEventOccurrence) => e.title === 'TZ Cancel Occ');
            const postDSTOcc = occurrences.find(
                (e: CalendarEventOccurrence) => new Date(e.startTime) > new Date('2026-03-29T00:00:00Z'),
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
                const afterOccs = afterEvents.filter(
                    (e: CalendarEventOccurrence) =>
                        e.title === 'TZ Cancel Occ' &&
                        e.occurrenceDate === postDSTOcc.occurrenceDate &&
                        !e.parentEventId,
                );
                expect(afterOccs.length).toBe(0);

                // Other occurrences still present
                const remainingOccs = afterEvents.filter(
                    (e: CalendarEventOccurrence) => e.title === 'TZ Cancel Occ' && !e.parentEventId,
                );
                expect(remainingOccs.length).toBe(occurrences.length - 1);
            }
        });
    });

    describe('Events in range with timezone', () => {
        test('timezone-aware recurring events appear in range query', async () => {
            // Create event at 23:30 Amsterdam (22:30 UTC pre-DST)
            const startTime = new Date('2026-03-16T22:30:00Z');

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'TZ Range Test',
                startTime,
                endTime: new Date(startTime.getTime() + 1800_000),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5',
                timezone: 'Europe/Amsterdam',
            });

            // Query a range that covers all 5 occurrences
            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-20T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: CalendarEventOccurrence) => e.title === 'TZ Range Test');
            expect(occurrences.length).toBe(5);
        });

        test('old events without timezone still work (backward compat)', async () => {
            // Event without timezone — should behave exactly like before
            const startTime = new Date('2026-03-16T22:30:00Z');

            await createEvent(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceCalendarId, {
                title: 'No TZ Compat',
                startTime,
                endTime: new Date(startTime.getTime() + 1800_000),
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
            });

            const from = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-10T00:00:00Z').getTime() / 1000);

            const events = await getEvents(ctx.alice.user.sessionToken, ctx.alice.user.id, from, to);
            const occurrences = events.filter((e: CalendarEventOccurrence) => e.title === 'No TZ Compat');
            expect(occurrences.length).toBe(3);

            // All at same UTC hour (no DST adjustment)
            for (const occ of occurrences) {
                const d = new Date(occ.startTime);
                expect(d.getUTCHours()).toBe(22);
                expect(d.getUTCMinutes()).toBe(30);
            }
        });
    });
});
