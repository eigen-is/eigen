import { beforeAll, describe, expect, test } from 'bun:test';
import type {
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    FreeBusyBlock,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import { assertJson, authedRequest, findOrFail, getTestContext } from './setup';

describe('Calendar', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalendarId: string;
    let aliceEventId: string;
    let aliceRecurringEventId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    describe('Calendar CRUD', () => {
        test('init creates default Personal calendar', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
            const calendars = await assertJson<CalendarItem[]>(res);
            expect(calendars.length).toBeGreaterThanOrEqual(1);
            const personal = findOrFail(calendars, (c) => c.isDefault === true);
            expect(personal.name).toBeTruthy();
            aliceCalendarId = personal.id;
        });

        test('create calendar', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Work', color: '#34a853' }),
            });
            const cal = await assertJson<CalendarItem>(res);
            expect(cal.name).toBe('Work');
            expect(cal.color).toBe('#34a853');
            expect(cal.isDefault).toBe(false);
            expect(cal.id).toBeDefined();
        });

        test('list calendars includes new calendar', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`);
            const calendars = await assertJson<CalendarItem[]>(res);
            expect(calendars.length).toBeGreaterThanOrEqual(2);
            expect(calendars.find((c: CalendarItem) => c.name === 'Work')).toBeDefined();
        });

        test('update calendar name and color', async () => {
            const listRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
            );
            const calendars = await assertJson<CalendarItem[]>(listRes);
            const work = findOrFail(calendars, (c) => c.name === 'Work');

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${work.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Work Projects', color: '#4285f4' }),
                },
            );
            const updated = await assertJson<CalendarItem>(res);
            expect(updated.name).toBe('Work Projects');
            expect(updated.color).toBe('#4285f4');
        });

        test('delete non-default calendar succeeds', async () => {
            const listRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
            );
            const calendars = await assertJson<CalendarItem[]>(listRes);
            const work = findOrFail(calendars, (c) => c.name === 'Work Projects');

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${work.id}`,
                { method: 'DELETE' },
            );
            expect(res.status).toBe(200);

            const listRes2 = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
            );
            const calendars2 = await assertJson<CalendarItem[]>(listRes2);
            expect(calendars2.find((c: CalendarItem) => c.name === 'Work Projects')).toBeUndefined();
        });

        test('delete default calendar fails', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}`,
                { method: 'DELETE' },
            );
            expect(res.status).toBe(400);
        });
    });

    describe('Event CRUD', () => {
        test('create event with all fields', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Team Standup',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        description: 'Daily sync',
                        location: 'Room A',
                        data: { reminders: [{ type: 'notification', minutes: 10 }] },
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.title).toBe('Team Standup');
            expect(event.description).toBe('Daily sync');
            expect(event.location).toBe('Room A');
            expect(event.startTime).toBe(1741773600);
            expect(event.endTime).toBe(1741777200);
            expect(event.allDay).toBe(false);
            expect(event.status).toBe('confirmed');
            expect(event.uid).toBeDefined();
            expect(event.uri).toContain('.ics');
            expect(event.data!.reminders).toHaveLength(1);
            aliceEventId = event.id;
        });

        test('create event with minimal fields', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Lunch',
                        startTime: 1741780800,
                        endTime: 1741784400,
                        allDay: false,
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.title).toBe('Lunch');
            expect(event.description).toBeNull();
            expect(event.location).toBeNull();
            expect(event.status).toBe('confirmed');
        });

        test('create all-day event', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Company Holiday',
                        startTime: 1741737600,
                        endTime: 1741824000,
                        allDay: true,
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.allDay).toBe(true);
        });

        test('update event partially', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${aliceEventId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Team Standup (updated)', location: 'Room B' }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.title).toBe('Team Standup (updated)');
            expect(event.location).toBe('Room B');
            expect(event.description).toBe('Daily sync');
        });

        test('etag changes on update', async () => {
            const res1 = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${aliceEventId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Team Standup v2' }),
                },
            );
            const event1 = await assertJson<CalendarEvent>(res1);
            const etag1 = event1.etag;

            const res2 = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${aliceEventId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Team Standup v3' }),
                },
            );
            const event2 = await assertJson<CalendarEvent>(res2);
            expect(event2.etag).not.toBe(etag1);
        });

        test('delete event', async () => {
            const createRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'To Delete',
                        startTime: 1741780800,
                        endTime: 1741784400,
                        allDay: false,
                    }),
                },
            );
            const created = await assertJson<CalendarEvent>(createRes);

            const delRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${created.id}`,
                { method: 'DELETE' },
            );
            expect(delRes.status).toBe(200);

            const rangeRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/event-range/1741737600/1741824000`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(rangeRes);
            expect(events.find((e: CalendarEventOccurrence) => e.id === created.id)).toBeUndefined();
        });
    });

    describe('RRULE storage and round-trip', () => {
        test('create recurring event with RRULE string and get it back', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Weekly Sync',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;BYDAY=WE',
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.rrule).toBe('FREQ=WEEKLY;BYDAY=WE');
            aliceRecurringEventId = event.id;
        });

        test('monthly recurrence with BYMONTHDAY', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Monthly Review',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12',
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12');
        });

        test('daily with interval', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Every 3 Days',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=DAILY;INTERVAL=3',
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.rrule).toBe('FREQ=DAILY;INTERVAL=3');
        });

        test('complex RRULE with BYSETPOS (last Friday)', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Last Friday',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1',
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.rrule).toBe('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1');
        });

        test('RRULE with BYHOUR/BYMINUTE survives round-trip (CalDAV readiness)', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'CalDAV Complex',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30',
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30');
        });

        test('non-recurring event has null rrule', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'One-off Meeting',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.rrule).toBeNull();
        });
    });

    describe('Recurrence expansion', () => {
        test('weekly recurring event expands in range', async () => {
            const from = 1741737600;
            const to = from + 28 * 86400;
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(res);
            const weeklySyncs = events.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Sync');
            expect(weeklySyncs.length).toBeGreaterThanOrEqual(2);
            for (const e of weeklySyncs) {
                expect(e.occurrenceDate).toBeDefined();
            }
        });

        test('events outside range are excluded', async () => {
            const from = 1;
            const to = 100;
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(res);
            expect(events.length).toBe(0);
        });
    });

    describe('Recurrence exceptions', () => {
        test('cancel a single occurrence', async () => {
            const from = 1741737600;
            const to = from + 28 * 86400;

            const beforeRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const beforeEvents = await assertJson<CalendarEventOccurrence[]>(beforeRes);
            const weeklySyncs = beforeEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Sync');
            const targetDate = weeklySyncs[1]?.occurrenceDate;

            if (targetDate) {
                const cancelRes = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: 'Weekly Sync',
                            startTime: weeklySyncs[1].startTime,
                            endTime: weeklySyncs[1].endTime,
                            allDay: false,
                            parentEventId: aliceRecurringEventId,
                            recurrenceDate: targetDate,
                            status: 'cancelled',
                        }),
                    },
                );
                expect(cancelRes.status).toBe(200);

                const afterRes = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
                );
                const afterEvents = await assertJson<CalendarEventOccurrence[]>(afterRes);
                const afterSyncs = afterEvents.filter(
                    (e: CalendarEventOccurrence) =>
                        e.title === 'Weekly Sync' && e.occurrenceDate === targetDate && !e.parentEventId,
                );
                expect(afterSyncs.length).toBe(0);
            }
        });

        test('cancel a single occurrence with ISO datetime recurrenceDate (FE format)', async () => {
            const from = 1741737600;
            const to = from + 28 * 86400;

            const beforeRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const beforeEvents = await assertJson<CalendarEventOccurrence[]>(beforeRes);
            const weeklySyncs = beforeEvents.filter(
                (e: CalendarEventOccurrence) => e.title === 'Weekly Sync' && !e.parentEventId,
            );
            const target = weeklySyncs[0];

            if (target) {
                const isoDate = new Date(target.occurrenceDate).toISOString();

                const cancelRes = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: target.title,
                            startTime: target.startTime,
                            endTime: target.endTime,
                            allDay: false,
                            parentEventId: aliceRecurringEventId,
                            recurrenceDate: isoDate,
                            status: 'cancelled',
                        }),
                    },
                );
                expect(cancelRes.status).toBe(200);

                const afterRes = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
                );
                const afterEvents = await assertJson<CalendarEventOccurrence[]>(afterRes);
                const afterSyncs = afterEvents.filter(
                    (e: CalendarEventOccurrence) =>
                        e.title === 'Weekly Sync' && e.occurrenceDate === target.occurrenceDate && !e.parentEventId,
                );
                expect(afterSyncs.length).toBe(0);
            }
        });

        test('modify a single occurrence', async () => {
            const from = 1741737600;
            const to = from + 28 * 86400;

            const beforeRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const beforeEvents = await assertJson<CalendarEventOccurrence[]>(beforeRes);
            const weeklySyncs = beforeEvents.filter(
                (e: CalendarEventOccurrence) => e.title === 'Weekly Sync' && !e.parentEventId,
            );
            const first = weeklySyncs[0];

            if (first) {
                const modRes = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: 'Weekly Sync (moved)',
                            startTime: first.startTime + 3600,
                            endTime: first.endTime + 3600,
                            allDay: false,
                            parentEventId: aliceRecurringEventId,
                            recurrenceDate: first.occurrenceDate,
                        }),
                    },
                );
                expect(modRes.status).toBe(200);

                const afterRes = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
                );
                const afterEvents = await assertJson<CalendarEventOccurrence[]>(afterRes);
                const modified = findOrFail(afterEvents, (e) => e.title === 'Weekly Sync (moved)');
                expect(modified.startTime).toBe(first.startTime + 3600);
            }
        });
    });

    describe('Delete modified exception', () => {
        test('cancelling a modified exception hides it instead of resurfacing original', async () => {
            const from = 1741737600;
            const to = from + 28 * 86400;

            // Create a weekly recurring event
            const createRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Exception Delete Test',
                        startTime: from + 3600,
                        endTime: from + 7200,
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;COUNT=4',
                    }),
                },
            );
            const parent = await assertJson<CalendarEvent>(createRes);

            // Get the first occurrence
            const eventsRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
            const firstOcc = findOrFail(events, (e) => e.title === 'Exception Delete Test');

            // Modify the first occurrence (create exception)
            const modRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Exception Delete Test (modified)',
                        startTime: firstOcc.startTime + 1800,
                        endTime: firstOcc.endTime + 1800,
                        allDay: false,
                        parentEventId: parent.id,
                        recurrenceDate: firstOcc.occurrenceDate,
                    }),
                },
            );
            const exception = await assertJson<CalendarEvent>(modRes);

            // Now cancel the exception (simulate "delete this" on a modified occurrence)
            const cancelRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${exception.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'cancelled' }),
                },
            );
            expect(cancelRes.status).toBe(200);

            // The occurrence should be gone — not resurfaced as the original
            const afterRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const afterEvents = await assertJson<CalendarEventOccurrence[]>(afterRes);
            const remaining = afterEvents.filter(
                (e: CalendarEventOccurrence) =>
                    e.title === 'Exception Delete Test' || e.title === 'Exception Delete Test (modified)',
            );
            // Should have 3 occurrences (4 total - 1 cancelled), not 4
            expect(remaining.length).toBe(3);
            expect(
                remaining.find((e: CalendarEventOccurrence) => e.occurrenceDate === firstOcc.occurrenceDate),
            ).toBeUndefined();
        });
    });

    describe('This and following operations', () => {
        let thisFollowingEventId = '';

        test('setup: create a daily recurring event for this-and-following tests', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Daily Standup',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=DAILY',
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            thisFollowingEventId = event.id;
        });

        test('delete this and following: truncate RRULE with UNTIL removes future occurrences', async () => {
            const from = 1741737600;
            const to = from + 14 * 86400;

            const beforeRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const beforeEvents = await assertJson<CalendarEventOccurrence[]>(beforeRes);
            const standups = beforeEvents.filter((e: CalendarEventOccurrence) => e.title === 'Daily Standup');
            expect(standups.length).toBeGreaterThanOrEqual(10);

            const cutoffOcc = standups[5];
            const cutoffDate = new Date(`${cutoffOcc.occurrenceDate}T00:00:00Z`);
            const untilDate = new Date(cutoffDate);
            untilDate.setUTCDate(untilDate.getUTCDate() - 1);
            untilDate.setUTCHours(23, 59, 59, 0);
            const untilStr = untilDate
                .toISOString()
                .replace(/[-:]/g, '')
                .replace(/\.\d{3}/, '');

            const truncatedRRule = `FREQ=DAILY;UNTIL=${untilStr}`;
            const updateRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${thisFollowingEventId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rrule: truncatedRRule }),
                },
            );
            expect(updateRes.status).toBe(200);

            const afterRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const afterEvents = await assertJson<CalendarEventOccurrence[]>(afterRes);
            const afterStandups = afterEvents.filter((e: CalendarEventOccurrence) => e.title === 'Daily Standup');
            expect(afterStandups.length).toBe(5);
            for (const s of afterStandups) {
                expect(s.occurrenceDate < cutoffOcc.occurrenceDate).toBe(true);
            }
        });

        test('edit this and following: truncate parent + create new series', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Weekly Review',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;BYDAY=WE',
                    }),
                },
            );
            const parentEvent = await assertJson<CalendarEvent>(res);

            const from = 1741737600;
            const to = from + 42 * 86400;
            const beforeRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const beforeEvents = await assertJson<CalendarEventOccurrence[]>(beforeRes);
            const reviews = beforeEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Review');
            expect(reviews.length).toBeGreaterThanOrEqual(4);

            const cutoffOcc = reviews[2];
            const cutoffDate = new Date(`${cutoffOcc.occurrenceDate}T00:00:00Z`);
            const untilDate = new Date(cutoffDate);
            untilDate.setUTCDate(untilDate.getUTCDate() - 1);
            untilDate.setUTCHours(23, 59, 59, 0);
            const untilStr = untilDate
                .toISOString()
                .replace(/[-:]/g, '')
                .replace(/\.\d{3}/, '');
            const truncatedRRule = `FREQ=WEEKLY;BYDAY=WE;UNTIL=${untilStr}`;

            const updateRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${parentEvent.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rrule: truncatedRRule }),
                },
            );
            expect(updateRes.status).toBe(200);

            const newRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Weekly Review (updated)',
                        startTime: cutoffOcc.startTime + 3600,
                        endTime: cutoffOcc.endTime + 3600,
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;BYDAY=WE',
                    }),
                },
            );
            expect(newRes.status).toBe(200);

            const afterRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/event-range/${from}/${to}`,
            );
            const afterEvents = await assertJson<CalendarEventOccurrence[]>(afterRes);
            const oldReviews = afterEvents.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Review');
            const newReviews = afterEvents.filter(
                (e: CalendarEventOccurrence) => e.title === 'Weekly Review (updated)',
            );
            expect(oldReviews.length).toBe(2);
            expect(newReviews.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('Range queries', () => {
        test('empty range returns empty array', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/event-range/1000000000/1000000001`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(res);
            expect(events.length).toBe(0);
        });

        test('range query returns events in range', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/event-range/1741737600/1741824000`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(res);
            expect(events.length).toBeGreaterThan(0);
        });
    });

    describe('Sharing', () => {
        let sharedCalendarId: string;

        test('share calendar with Bob', async () => {
            const createRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Shared Cal', color: '#ea4335' }),
                },
            );
            const cal = await assertJson<CalendarItem>(createRes);
            sharedCalendarId = cal.id;

            const createEventRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Shared Event',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                    }),
                },
            );
            expect(createEventRes.status).toBe(200);

            const shareRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        shares: [{ targetId: ctx.bob.user.email, permission: 'read' }],
                    }),
                },
            );
            expect(shareRes.status).toBe(200);
        });

        test('Bob sees shared calendar in shared list', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
            const shared = await assertJson<SharedCalendar[]>(res);
            const found = findOrFail(shared, (s) => s.calendarId === sharedCalendarId);
            expect(found.calendarName).toBe('Shared Cal');
            expect(found.permission).toBe('read');
        });

        test('Bob can read events from shared calendar', async () => {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/event-range/1741737600/1741824000`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(res);
            expect(events.length).toBeGreaterThan(0);
            expect(events[0].title).toBe('Shared Event');
        });

        test('Bob cannot write to read-only shared calendar', async () => {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Bob Event',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                    }),
                },
            );
            expect(res.status).toBe(403);
        });

        test('Charlie has no access to shared calendar', async () => {
            const res = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/event-range/1741737600/1741824000`,
            );
            expect(res.status).toBe(403);
        });

        test('upgrade Bob to write permission', async () => {
            const shareRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        shares: [{ targetId: ctx.bob.user.email, permission: 'write' }],
                    }),
                },
            );
            expect(shareRes.status).toBe(200);

            const writeRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Bob Event',
                        startTime: 1741780800,
                        endTime: 1741784400,
                        allDay: false,
                    }),
                },
            );
            expect(writeRes.status).toBe(200);
            const event = await assertJson<CalendarEvent>(writeRes);
            expect(event.title).toBe('Bob Event');
        });

        test('Bob can update event on shared calendar with write permission', async () => {
            const eventsRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/event-range/1741737600/1741824000`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
            const bobEvent = findOrFail(events, (e) => e.title === 'Bob Event');

            const updateRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events/${bobEvent.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Bob Event Updated' }),
                },
            );
            const updated = await assertJson<CalendarEvent>(updateRes);
            expect(updated.title).toBe('Bob Event Updated');
        });

        test('Bob can delete event on shared calendar with write permission', async () => {
            const eventsRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/event-range/1741737600/1741824000`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
            const bobEvent = findOrFail(events, (e) => e.title === 'Bob Event Updated');

            const deleteRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events/${bobEvent.id}`,
                {
                    method: 'DELETE',
                },
            );
            expect(deleteRes.status).toBe(200);
        });

        test('read-only user cannot update or delete shared events', async () => {
            const shareRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        shares: [
                            { targetId: ctx.bob.user.email, permission: 'write' },
                            { targetId: ctx.charlie.user.email, permission: 'read' },
                        ],
                    }),
                },
            );
            expect(shareRes.status).toBe(200);

            const eventsRes = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/event-range/1741737600/1741824000`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(eventsRes);
            expect(events.length).toBeGreaterThan(0);
            const eventId = events[0].id;

            const updateRes = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events/${eventId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Hacked' }),
                },
            );
            expect(updateRes.status).toBe(403);

            const deleteRes = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events/${eventId}`,
                {
                    method: 'DELETE',
                },
            );
            expect(deleteRes.status).toBe(403);
        });

        test('created event has createByUserId set', async () => {
            const createRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Bob Created Event',
                        startTime: 1741780800,
                        endTime: 1741784400,
                        allDay: false,
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(createRes);
            expect(event.createByUserId).toBe(ctx.bob.user.id);
        });

        test('free-busy permission returns only time blocks', async () => {
            const shareRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        shares: [
                            { targetId: ctx.bob.user.email, permission: 'write' },
                            { targetId: ctx.charlie.user.email, permission: 'free-busy' },
                        ],
                    }),
                },
            );
            expect(shareRes.status).toBe(200);

            const res = await authedRequest(
                ctx.charlie.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}/event-range/1741737600/1741824000`,
            );
            const blocks = await assertJson<FreeBusyBlock[]>(res);
            expect(blocks.length).toBeGreaterThan(0);
            expect(blocks[0].startTime).toBeDefined();
            expect(blocks[0].endTime).toBeDefined();
            expect('title' in blocks[0]).toBe(false);
            expect('description' in blocks[0]).toBe(false);
        });

        test('unshare removes from Bob shared list', async () => {
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalendarId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ shares: [] }),
                },
            );

            const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/shared`);
            const shared = await assertJson<SharedCalendar[]>(res);
            expect(shared.find((s: SharedCalendar) => s.calendarId === sharedCalendarId)).toBeUndefined();
        });
    });

    describe('Cross-user isolation', () => {
        test('Bob calendars are separate from Alice', async () => {
            const aliceRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
            );
            const aliceCals = await assertJson<CalendarItem[]>(aliceRes);

            const bobRes = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`);
            const bobCals = await assertJson<CalendarItem[]>(bobRes);

            const aliceIds = new Set(aliceCals.map((c: CalendarItem) => c.id));
            const bobIds = new Set(bobCals.map((c: CalendarItem) => c.id));
            const overlap = [...aliceIds].filter((id) => bobIds.has(id));
            expect(overlap.length).toBe(0);
        });
    });

    describe('Frontend-like event creation and range queries', () => {
        let freshCalendarId: string;

        beforeAll(async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars`);
            const calendars = await assertJson<CalendarItem[]>(res);
            freshCalendarId = findOrFail(calendars, (c) => c.isDefault).id;
        });

        test('create timed event (like FE sends) and verify occurrenceDate in range response', async () => {
            const startTime = Math.floor(new Date('2026-03-10T09:00:00Z').getTime() / 1000);
            const endTime = Math.floor(new Date('2026-03-10T10:00:00Z').getTime() / 1000);

            const createRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${freshCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Morning Meeting',
                        startTime,
                        endTime,
                        allDay: false,
                        description: null,
                        location: null,
                        rrule: null,
                    }),
                },
            );
            const created = await assertJson<CalendarEvent>(createRes);
            expect(created.id).toBeDefined();
            expect(created.title).toBe('Morning Meeting');

            const from = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-03-31T23:59:59Z').getTime() / 1000);
            const rangeRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(rangeRes);
            const found = findOrFail(events, (e) => e.id === created.id);
            expect(found.occurrenceDate).toBe('2026-03-10');
            expect(found.title).toBe('Morning Meeting');
        });

        test('create all-day event (FE style: midnight UTC to next midnight UTC) and verify occurrenceDate', async () => {
            const startTime = Math.floor(new Date('2026-03-15T00:00:00Z').getTime() / 1000);
            const endTime = Math.floor(new Date('2026-03-16T00:00:00Z').getTime() / 1000);

            const createRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${freshCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'All Day Conference',
                        startTime,
                        endTime,
                        allDay: true,
                    }),
                },
            );
            expect(createRes.status).toBe(200);

            const from = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-03-31T23:59:59Z').getTime() / 1000);
            const rangeRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(rangeRes);
            const found = findOrFail(events, (e) => e.title === 'All Day Conference');
            expect(found.occurrenceDate).toBe('2026-03-15');
            expect(found.allDay).toBe(true);
        });

        test('create multi-day all-day event and verify occurrenceDate is start date', async () => {
            const startTime = Math.floor(new Date('2026-03-20T00:00:00Z').getTime() / 1000);
            const endTime = Math.floor(new Date('2026-03-23T00:00:00Z').getTime() / 1000);

            await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${freshCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: '3-Day Retreat',
                        startTime,
                        endTime,
                        allDay: true,
                    }),
                },
            );

            const from = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-03-31T23:59:59Z').getTime() / 1000);
            const rangeRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(rangeRes);
            const found = findOrFail(events, (e) => e.title === '3-Day Retreat');
            expect(found.occurrenceDate).toBe('2026-03-20');
        });

        test('event at end of day boundary is included in correct range', async () => {
            const startTime = Math.floor(new Date('2026-03-31T23:00:00Z').getTime() / 1000);
            const endTime = Math.floor(new Date('2026-04-01T00:30:00Z').getTime() / 1000);

            const createRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${freshCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Late Night Event',
                        startTime,
                        endTime,
                        allDay: false,
                    }),
                },
            );
            const created = await assertJson<CalendarEvent>(createRes);

            const marchFrom = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000);
            const marchTo = Math.floor(new Date('2026-03-31T23:59:59Z').getTime() / 1000);
            const marchRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${marchFrom}/${marchTo}`,
            );
            const marchEvents = await assertJson<CalendarEventOccurrence[]>(marchRes);
            expect(marchEvents.find((e: CalendarEventOccurrence) => e.id === created.id)).toBeDefined();

            const aprilFrom = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);
            const aprilTo = Math.floor(new Date('2026-04-30T23:59:59Z').getTime() / 1000);
            const aprilRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${aprilFrom}/${aprilTo}`,
            );
            const aprilEvents = await assertJson<CalendarEventOccurrence[]>(aprilRes);
            expect(aprilEvents.find((e: CalendarEventOccurrence) => e.id === created.id)).toBeDefined();
        });

        test('event not in range is excluded', async () => {
            const janFrom = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
            const janTo = Math.floor(new Date('2026-01-31T23:59:59Z').getTime() / 1000);
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${janFrom}/${janTo}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(res);
            const marchEvents = events.filter(
                (e: CalendarEventOccurrence) => e.title === 'Morning Meeting' || e.title === 'All Day Conference',
            );
            expect(marchEvents.length).toBe(0);
        });

        test('timed event created in UTC+1 style (local midnight = 23:00 UTC prev day) appears correctly', async () => {
            const startTime = Math.floor(new Date('2026-03-10T08:00:00Z').getTime() / 1000);
            const endTime = Math.floor(new Date('2026-03-10T09:00:00Z').getTime() / 1000);

            const createRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${freshCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'UTC+1 Morning',
                        startTime,
                        endTime,
                        allDay: false,
                    }),
                },
            );
            expect(createRes.status).toBe(200);

            const from = Math.floor(new Date('2026-02-22T23:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-05T22:59:59Z').getTime() / 1000);
            const rangeRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(rangeRes);
            const found = findOrFail(events, (e) => e.title === 'UTC+1 Morning');
            expect(found.occurrenceDate).toBe('2026-03-10');
        });

        test('all-day event with FE UTC midnight matches backend occurrenceDate', async () => {
            const startTime = Math.floor(new Date('2026-06-15T00:00:00Z').getTime() / 1000);
            const endTime = Math.floor(new Date('2026-06-16T00:00:00Z').getTime() / 1000);

            await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${freshCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Summer Holiday',
                        startTime,
                        endTime,
                        allDay: true,
                    }),
                },
            );

            const from = Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-06-30T23:59:59Z').getTime() / 1000);
            const rangeRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(rangeRes);
            const found = findOrFail(events, (e) => e.title === 'Summer Holiday');
            expect(found.occurrenceDate).toBe('2026-06-15');
        });

        test('recurring weekly event creates correct occurrences in range', async () => {
            const startTime = Math.floor(new Date('2026-04-06T14:00:00Z').getTime() / 1000);
            const endTime = Math.floor(new Date('2026-04-06T15:00:00Z').getTime() / 1000);

            await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${freshCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Weekly Standup Bob',
                        startTime,
                        endTime,
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;BYDAY=MO',
                    }),
                },
            );

            const from = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-04-30T23:59:59Z').getTime() / 1000);
            const rangeRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(rangeRes);
            const standups = events.filter((e: CalendarEventOccurrence) => e.title === 'Weekly Standup Bob');
            expect(standups.length).toBeGreaterThanOrEqual(4);

            const dates = standups.map((e: CalendarEventOccurrence) => e.occurrenceDate).sort();
            expect(dates).toContain('2026-04-06');
            expect(dates).toContain('2026-04-13');
            expect(dates).toContain('2026-04-20');
            expect(dates).toContain('2026-04-27');

            for (const s of standups) {
                expect(s.endTime - s.startTime).toBe(3600);
            }
        });

        test('daily recurring event with COUNT limits occurrences', async () => {
            const startTime = Math.floor(new Date('2026-05-01T10:00:00Z').getTime() / 1000);
            const endTime = Math.floor(new Date('2026-05-01T11:00:00Z').getTime() / 1000);

            await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${freshCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Sprint Countdown',
                        startTime,
                        endTime,
                        allDay: false,
                        rrule: 'FREQ=DAILY;COUNT=5',
                    }),
                },
            );

            const from = Math.floor(new Date('2026-05-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-05-31T23:59:59Z').getTime() / 1000);
            const rangeRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(rangeRes);
            const countdowns = events.filter((e: CalendarEventOccurrence) => e.title === 'Sprint Countdown');
            expect(countdowns.length).toBe(5);
            expect(countdowns[0].occurrenceDate).toBe('2026-05-01');
            expect(countdowns[4].occurrenceDate).toBe('2026-05-05');
        });

        test('all events in range response have occurrenceDate field', async () => {
            const from = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-03-31T23:59:59Z').getTime() / 1000);
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(res);
            expect(events.length).toBeGreaterThan(0);
            for (const e of events) {
                expect(e.occurrenceDate).toBeDefined();
                expect(e.occurrenceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            }
        });

        test('per-calendar range query only returns events from that calendar', async () => {
            const createCalRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Side Project', color: '#ff6600' }),
                },
            );
            const sideCal = await assertJson<CalendarItem>(createCalRes);

            const startTime = Math.floor(new Date('2026-03-12T15:00:00Z').getTime() / 1000);
            const endTime = Math.floor(new Date('2026-03-12T16:00:00Z').getTime() / 1000);
            await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${sideCal.id}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Side Project Meeting',
                        startTime,
                        endTime,
                        allDay: false,
                    }),
                },
            );

            const from = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2026-03-31T23:59:59Z').getTime() / 1000);

            const sideRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/calendars/${sideCal.id}/event-range/${from}/${to}`,
            );
            const sideEvents = await assertJson<CalendarEventOccurrence[]>(sideRes);
            expect(sideEvents.length).toBe(1);
            expect(sideEvents[0].title).toBe('Side Project Meeting');

            const allRes = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.bob.user.id}/event-range/${from}/${to}`,
            );
            const allEvents = await assertJson<CalendarEventOccurrence[]>(allRes);
            expect(allEvents.find((e: CalendarEventOccurrence) => e.title === 'Side Project Meeting')).toBeDefined();
            expect(allEvents.find((e: CalendarEventOccurrence) => e.title === 'Morning Meeting')).toBeDefined();

            await authedRequest(ctx.bob.user.sessionToken, `/calendar/${ctx.bob.user.id}/calendars/${sideCal.id}`, {
                method: 'DELETE',
            });
        });
    });

    describe('Regression: Malformed RRULE validation', () => {
        test('create event with invalid RRULE returns 400', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Bad Recurrence',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'INVALID_RRULE_STRING',
                    }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('create event with garbage RRULE returns 400', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Garbage Recurrence',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: ';;;not-a-rule;;;',
                    }),
                },
            );
            expect(res.status).toBe(400);
        });

        test('update event with invalid RRULE returns 400', async () => {
            // First create a valid event
            const createRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Valid Event For RRULE Update Test',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(createRes);

            // Try to update with invalid RRULE
            const updateRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        rrule: 'NOT_VALID_AT_ALL',
                    }),
                },
            );
            expect(updateRes.status).toBe(400);
        });

        test('valid RRULE still works after rejection of invalid ones', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Valid After Invalid',
                        startTime: 1741773600,
                        endTime: 1741777200,
                        allDay: false,
                        rrule: 'FREQ=DAILY;COUNT=5',
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.rrule).toBe('FREQ=DAILY;COUNT=5');
        });
    });
});
