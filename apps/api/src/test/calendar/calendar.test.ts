import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { type SeriesEdit, seriesEditFromOccurrence } from '@workspace/lib/calendar/calendar-utils';
import type {
    CalendarEvent,
    CalendarEventOccurrence,
    CalendarItem,
    FreeBusyBlock,
    SharedCalendar,
} from '@workspace/lib/types/calendar';
import type { Notification } from '@workspace/lib/types/notification';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import type { Calendar } from '../../lib/calendar/calendar';
import * as schema from '../../lib/calendar/schema';
import { getHome } from '../../lib/home';
import {
    CALENDAR_TEST_ROOT,
    defaultCalendarId,
    makeCalendar,
    putResource,
    resourceTextOf,
    storedBytes,
    vevent,
} from '../calendar-test-helpers';
import { vcal } from '../ics-test-helpers';
import { assertJson, authedRequest, eventually, findOrFail, getTestContext } from '../setup';

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

            const listRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
            );
            const calendars = await assertJson<CalendarItem[]>(listRes);
            expect(calendars.length).toBeGreaterThanOrEqual(2);
            expect(calendars.find((c: CalendarItem) => c.id === cal.id)).toBeDefined();
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

        const createCalendarRequest = (body: unknown) =>
            authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

        test('a color that is not a hex color is refused', async () => {
            const res = await createCalendarRequest({ name: 'Hostile', color: 'javascript:alert(1)' });
            expect(res.status).toBe(400);

            const listRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
            );
            const calendars = await assertJson<CalendarItem[]>(listRes);
            expect(calendars.find((c) => c.name === 'Hostile')).toBeUndefined();
        });

        test('a 3 000-character name is refused', async () => {
            const res = await createCalendarRequest({ name: 'x'.repeat(3000), color: '#34a853' });
            expect(res.status).toBeGreaterThanOrEqual(400);

            const listRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
            );
            const calendars = await assertJson<CalendarItem[]>(listRes);
            expect(calendars.find((c) => c.name.length > 200)).toBeUndefined();
        });

        test('a calendar created without a color gets the default one', async () => {
            const created = await assertJson<CalendarItem>(await createCalendarRequest({ name: 'No Color' }));
            expect(created.color).toBe('#4285f4');

            await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars/${created.id}`, {
                method: 'DELETE',
            });
        });

        test('an update refuses a bad color and a bad name, and keeps the stored ones', async () => {
            const created = await assertJson<CalendarItem>(
                await createCalendarRequest({ name: 'Bounded', color: '#34a853' }),
            );
            const update = (body: unknown) =>
                authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars/${created.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

            expect((await update({ color: 'javascript:alert(1)' })).status).toBe(400);
            expect((await update({ name: 'y'.repeat(3000) })).status).toBeGreaterThanOrEqual(400);
            // Apple writes the eight-digit form; it stays valid.
            expect((await update({ color: '#34a85380' })).status).toBe(200);

            const listRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
            );
            const stored = findOrFail(await assertJson<CalendarItem[]>(listRes), (c) => c.id === created.id);
            expect(stored.name).toBe('Bounded');
            expect(stored.color).toBe('#34a85380');

            await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars/${created.id}`, {
                method: 'DELETE',
            });
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
                        startTime: new Date(1741773600 * 1000),
                        endTime: new Date(1741777200 * 1000),
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
            expect(new Date(event.startTime).getTime()).toBe(1741773600 * 1000);
            expect(new Date(event.endTime).getTime()).toBe(1741777200 * 1000);
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
                        startTime: new Date(1741780800 * 1000),
                        endTime: new Date(1741784400 * 1000),
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
                        startTime: new Date(1741780800 * 1000),
                        endTime: new Date(1741784400 * 1000),
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
        // RRULE strings are stored and transmitted as-is, so every shape a client may write comes back as it
        // went in. ical.js owns the serialization, so the parts round-trip by meaning, not by order.
        test('every rule shape comes back as it went in', async () => {
            const rules = {
                'Weekly Sync': 'FREQ=WEEKLY;BYDAY=WE',
                'Monthly Review': 'FREQ=MONTHLY;BYMONTHDAY=15;COUNT=12',
                'Every 3 Days': 'FREQ=DAILY;INTERVAL=3',
                'Last Friday': 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1',
                'CalDAV Complex': 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30',
            };
            for (const [title, rrule] of Object.entries(rules)) {
                const res = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title,
                            startTime: new Date(1741773600 * 1000),
                            endTime: new Date(1741777200 * 1000),
                            allDay: false,
                            rrule,
                        }),
                    },
                );
                const event = await assertJson<CalendarEvent>(res);
                expect(event.rrule!.split(';').sort()).toEqual(rrule.split(';').sort());
                // The weekly one is the series every exception test below overrides an occurrence of.
                if (title === 'Weekly Sync') aliceRecurringEventId = event.id;
            }
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
                        startTime: new Date(1741773600 * 1000),
                        endTime: new Date(1741777200 * 1000),
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
            expect(weeklySyncs.length).toBeGreaterThan(1);
            const targetDate = weeklySyncs[1].occurrenceDate;

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
            expect(weeklySyncs.length).toBeGreaterThan(0);
            const first = weeklySyncs[0];

            const modRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Weekly Sync (moved)',
                        startTime: new Date(new Date(first.startTime).getTime() + 3600_000),
                        endTime: new Date(new Date(first.endTime).getTime() + 3600_000),
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
            expect(new Date(modified.startTime).getTime()).toBe(new Date(first.startTime).getTime() + 3600_000);
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
                        startTime: new Date((from + 3600) * 1000),
                        endTime: new Date((from + 7200) * 1000),
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
                        startTime: new Date(new Date(firstOcc.startTime).getTime() + 1800_000),
                        endTime: new Date(new Date(firstOcc.endTime).getTime() + 1800_000),
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
            // Should have 3 occurrences (4 total - 1 canceled), not 4
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
                        startTime: new Date(1741773600 * 1000),
                        endTime: new Date(1741777200 * 1000),
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
                        startTime: new Date(1741773600 * 1000),
                        endTime: new Date(1741777200 * 1000),
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
                        startTime: new Date(new Date(cutoffOcc.startTime).getTime() + 3600_000),
                        endTime: new Date(new Date(cutoffOcc.endTime).getTime() + 3600_000),
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
                        startTime: new Date(1741773600 * 1000),
                        endTime: new Date(1741777200 * 1000),
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

        test('Bob gets a calendar-share notification with the actor display name', async () => {
            const notifs = await assertJson<Notification[]>(
                await authedRequest(ctx.bob.user.sessionToken, `/notifications/${ctx.bob.user.id}`),
            );
            const shared = notifs.find((n) => n.tag === `calendar-share:${sharedCalendarId}:${ctx.alice.user.id}`);
            expect(shared?.title).toBe(`${ctx.alice.user.name} shared a calendar`);
            expect(shared?.body).toBe('Shared Cal');
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
                        startTime: new Date(1741773600 * 1000),
                        endTime: new Date(1741777200 * 1000),
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
                        startTime: new Date(1741780800 * 1000),
                        endTime: new Date(1741784400 * 1000),
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
                        startTime: new Date(1741780800 * 1000),
                        endTime: new Date(1741784400 * 1000),
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

    describe('Cross-calendar write escalation (IDOR)', () => {
        let sharedCalId: string; // calendar A — Bob has write
        let privateCalId: string; // calendar B — Bob has no access
        let privateEventId: string;

        beforeAll(async () => {
            const aRes = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'IDOR Shared A', color: '#ea4335' }),
            });
            sharedCalId = (await assertJson<CalendarItem>(aRes)).id;
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ shares: [{ targetId: ctx.bob.user.email, permission: 'write' }] }),
                },
            );

            const bRes = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'IDOR Private B', color: '#4285f4' }),
            });
            privateCalId = (await assertJson<CalendarItem>(bRes)).id;
            const evRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${privateCalId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Alice Private Event',
                        startTime: new Date(1741773600 * 1000),
                        endTime: new Date(1741777200 * 1000),
                        allDay: false,
                    }),
                },
            );
            privateEventId = (await assertJson<CalendarEvent>(evRes)).id;
        });

        test('write-share on A cannot update an event living in B', async () => {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalId}/events/${privateEventId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Hijacked' }),
                },
            );
            expect(res.status).toBe(404);
        });

        test('write-share on A cannot delete an event living in B', async () => {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${sharedCalId}/events/${privateEventId}`,
                { method: 'DELETE' },
            );
            expect(res.status).toBe(404);
        });

        test('the B event is untouched after the escalation attempts', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${privateCalId}/event-range/1741737600/1741824000`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(res);
            const evt = findOrFail(events, (e) => e.id === privateEventId);
            expect(evt.title).toBe('Alice Private Event');
        });

        test('the owner can still edit the event via its own calId', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${privateCalId}/events/${privateEventId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: 'Alice Private Event Edited' }),
                },
            );
            expect(res.status).toBe(200);
            const updated = await assertJson<CalendarEvent>(res);
            expect(updated.title).toBe('Alice Private Event Edited');
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
            const startTime = new Date('2026-03-10T09:00:00Z');
            const endTime = new Date('2026-03-10T10:00:00Z');

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
            const startTime = new Date('2026-03-15T00:00:00Z');
            const endTime = new Date('2026-03-16T00:00:00Z');

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
            const startTime = new Date('2026-03-20T00:00:00Z');
            const endTime = new Date('2026-03-23T00:00:00Z');

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
            const startTime = new Date('2026-03-31T23:00:00Z');
            const endTime = new Date('2026-04-01T00:30:00Z');

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

        test('recurring weekly event creates correct occurrences in range', async () => {
            const startTime = new Date('2026-04-06T14:00:00Z');
            const endTime = new Date('2026-04-06T15:00:00Z');

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
                expect(new Date(s.endTime).getTime() - new Date(s.startTime).getTime()).toBe(3600_000);
            }
        });

        test('daily recurring event with COUNT limits occurrences', async () => {
            const startTime = new Date('2026-05-01T10:00:00Z');
            const endTime = new Date('2026-05-01T11:00:00Z');

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

            const startTime = new Date('2026-03-12T15:00:00Z');
            const endTime = new Date('2026-03-12T16:00:00Z');
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
        test('a create carrying an unparseable RRULE returns 400', async () => {
            for (const rrule of ['INVALID_RRULE_STRING', ';;;not-a-rule;;;']) {
                const res = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            title: 'Bad Recurrence',
                            startTime: new Date(1741773600 * 1000),
                            endTime: new Date(1741777200 * 1000),
                            allDay: false,
                            rrule,
                        }),
                    },
                );
                expect(res.status).toBe(400);
            }
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
                        startTime: new Date(1741773600 * 1000),
                        endTime: new Date(1741777200 * 1000),
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
    });

    // recurrenceDate is a wall-clock occurrence key (YYYY-MM-DD), but old FE builds sent the full
    // ISO datetime. The route normalizes to the canonical key at the boundary and rejects the
    // unkeyable — raw stored garbage used to crash CalDAV serving downstream.
    describe('Regression: recurrenceDate boundary normalization', () => {
        const exceptionBody = (recurrenceDate: string, parentEventId: string) => ({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Exception key format',
                startTime: new Date(1741773600 * 1000),
                endTime: new Date(1741777200 * 1000),
                allDay: false,
                parentEventId,
                recurrenceDate,
            }),
        });

        test('create exception with a full ISO datetime stores the wall-date key', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                exceptionBody('2026-03-19T04:00:00.000Z', aliceRecurringEventId),
            );
            const event = await assertJson<CalendarEvent>(res);
            expect(event.recurrenceDate).toBe('2026-03-19');
        });

        test('create exception with a garbage recurrenceDate returns 400', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                exceptionBody('garbage', aliceRecurringEventId),
            );
            expect(res.status).toBe(400);
        });
    });

    describe('Regression: recurrence DoS bounds (finding 19)', () => {
        const subDailyBody = (rrule: string) => ({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `DoS ${rrule}`,
                startTime: new Date(1741773600 * 1000),
                endTime: new Date(1741777200 * 1000),
                allDay: false,
                rrule,
            }),
        });

        test('a create carrying a sub-daily frequency returns 400', async () => {
            for (const rrule of ['FREQ=SECONDLY', 'FREQ=MINUTELY;INTERVAL=5', 'FREQ=HOURLY']) {
                const res = await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                    subDailyBody(rrule),
                );
                expect(res.status).toBe(400);
            }
        });

        test('update event to FREQ=SECONDLY returns 400', async () => {
            const createRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'DoS update target',
                        startTime: new Date(1741773600 * 1000),
                        endTime: new Date(1741777200 * 1000),
                        allDay: false,
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(createRes);
            const updateRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rrule: 'FREQ=SECONDLY' }),
                },
            );
            expect(updateRes.status).toBe(400);
        });

        // A recurring event whose dtstart is far outside the sane range (1900-2200) makes rrule
        // iterate dtstart→window even at an allowed frequency (~seconds of event-loop stall) —
        // reject it at the write boundary like the sub-daily frequencies.
        test('create recurring event with a far-out-of-range dtstart returns 400', async () => {
            const rangeBody = (startIso: string, endIso: string) => ({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'DoS out-of-range dtstart',
                    startTime: new Date(startIso),
                    endTime: new Date(endIso),
                    allDay: false,
                    rrule: 'FREQ=DAILY',
                }),
            });
            const ancient = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                rangeBody('1000-01-01T09:00:00Z', '1000-01-01T10:00:00Z'),
            );
            expect(ancient.status).toBe(400);
            const farFuture = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                rangeBody('9999-01-01T09:00:00Z', '9999-01-01T10:00:00Z'),
            );
            expect(farFuture.status).toBe(400);
        });

        test('update moving a recurring event start out of range returns 400', async () => {
            const createRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Range update target',
                        startTime: new Date('2027-03-01T09:00:00Z'),
                        endTime: new Date('2027-03-01T10:00:00Z'),
                        allDay: false,
                        rrule: 'FREQ=DAILY;COUNT=5',
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(createRes);
            const updateRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        startTime: new Date('1000-01-01T09:00:00Z'),
                        endTime: new Date('1000-01-01T10:00:00Z'),
                    }),
                },
            );
            expect(updateRes.status).toBe(400);
        });

        test('update adding an rrule to a far-out-of-range single event returns 400', async () => {
            // A single (non-recurring) event may sit anywhere in time — only pairing it with an
            // rrule creates the iterate-to-window vector.
            const createRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Ancient single event',
                        startTime: new Date('1000-01-01T09:00:00Z'),
                        endTime: new Date('1000-01-01T10:00:00Z'),
                        allDay: false,
                    }),
                },
            );
            const event = await assertJson<CalendarEvent>(createRes);
            const updateRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${aliceCalendarId}/events/${event.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rrule: 'FREQ=DAILY' }),
                },
            );
            expect(updateRes.status).toBe(400);
        });

        test('normal weekly recurrence still returns every occurrence (no regression)', async () => {
            const calRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'DoS Weekly Cal', color: '#00aa88' }),
                },
            );
            const cal = await assertJson<CalendarItem>(calRes);

            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${cal.id}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'DoS Weekly',
                        startTime: new Date('2027-01-04T09:00:00Z'), // Monday
                        endTime: new Date('2027-01-04T10:00:00Z'),
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=52',
                    }),
                },
            );

            const from = Math.floor(new Date('2027-01-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2027-12-31T23:59:59Z').getTime() / 1000);
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${cal.id}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(res);
            const weekly = events.filter((e) => e.title === 'DoS Weekly');
            // All 52 occurrences must survive the count cap + window clamp untouched.
            expect(weekly.length).toBe(52);
        });

        test('an over-wide window is clamped so expansion stays bounded', async () => {
            const calRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'DoS Clamp Cal', color: '#aa0088' }),
                },
            );
            const cal = await assertJson<CalendarItem>(calRes);

            // Unbounded DAILY rule (no COUNT/UNTIL) — the allowed-frequency vector.
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${cal.id}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'DoS Daily',
                        startTime: new Date('2030-01-01T09:00:00Z'),
                        endTime: new Date('2030-01-01T10:00:00Z'),
                        allDay: false,
                        rrule: 'FREQ=DAILY',
                    }),
                },
            );

            const from = Math.floor(new Date('2030-01-01T00:00:00Z').getTime() / 1000);
            const to = Math.floor(new Date('2038-01-01T00:00:00Z').getTime() / 1000); // 8-year span
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${cal.id}/event-range/${from}/${to}`,
            );
            const events = await assertJson<CalendarEventOccurrence[]>(res);
            const daily = events.filter((e) => e.title === 'DoS Daily');
            // Window clamped to ~5 years: bounded count and nothing near the requested 8-year edge.
            expect(daily.length).toBeGreaterThan(1500);
            expect(daily.length).toBeLessThan(2100);
            expect(daily.every((e) => e.occurrenceDate < '2036-01-01')).toBe(true);
        });
    });
});

describe('Calendar invite email to Eigen user', () => {
    let testCtx: Awaited<ReturnType<typeof getTestContext>>;
    let calendarId: string;

    beforeAll(async () => {
        testCtx = await getTestContext();
        const calRes = await authedRequest(
            testCtx.alice.user.sessionToken,
            `/calendar/${testCtx.alice.user.id}/calendars`,
        );
        const cals = await assertJson<Array<{ id: string }>>(calRes);
        calendarId = cals[0].id;
    });

    async function setToggle(value: boolean) {
        await authedRequest(testCtx.alice.user.sessionToken, '/settings/server', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notifications: { email: { userOnCalendarInvite: value } } }),
        });
    }

    async function createEventWithBob(title: string): Promise<void> {
        await authedRequest(
            testCtx.alice.user.sessionToken,
            `/calendar/${testCtx.alice.user.id}/calendars/${calendarId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    startTime: new Date(1745000000 * 1000),
                    endTime: new Date(1745003600 * 1000),
                    allDay: false,
                    data: {
                        attendees: [
                            {
                                email: testCtx.bob.user.email,
                                name: testCtx.bob.user.name,
                                status: 'pending',
                                role: 'required',
                            },
                        ],
                    },
                }),
            },
        );
    }

    const bobHoldsInvite = async (title: string): Promise<boolean> => {
        const home = await getHome(testCtx.bob.user.id);
        const calendars = await home.calendar.getCalendars();
        const rows = await Promise.all(calendars.map((c) => home.calendar.getRawEvents(c.id)));
        return rows.flat().some((e) => e.title === title);
    };

    // JsonStore is shared across the suite — reset before AND after each test.
    beforeEach(() => setToggle(true));
    afterEach(() => setToggle(true));

    test('emails Eigen attendee when toggle on', async () => {
        await setToggle(true);
        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        await createEventWithBob('Invite-toggle-on');

        const calls = await eventually(async () => {
            const sent = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === testCtx.bob.user.email));
            return sent.length ? sent : undefined;
        }, 'the invitation mail to Bob');
        expect(calls.length).toBe(1);
        expect(calls[0][0].subject).toContain('Invitation:');
        spy.mockRestore();
    });

    test('does not email Eigen attendee when toggle off', async () => {
        await setToggle(false);
        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear(); // spyOn returns a shared mock; reset call history per test

        await createEventWithBob('Invite-toggle-off');
        // The mail and the linked copy are two halves of one fan-out: once Bob holds the copy, a mail that
        // was going to be sent has been.
        await eventually(
            async () => (await bobHoldsInvite('Invite-toggle-off')) || undefined,
            "the invitation to reach Bob's calendar",
        );

        const calls = spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === testCtx.bob.user.email));
        expect(calls.length).toBe(0);
        spy.mockRestore();
    });
});

// Audit #24: every occurrence-level write keeps the series timezone, or the exception serializes in Z
// form and keys against a different wall-clock day than the series it belongs to.
describe('Calendar occurrence timezone consistency (audit #24)', () => {
    const NY = 'America/New_York';
    let testCtx: Awaited<ReturnType<typeof getTestContext>>;
    let aliceCalId: string;
    let bobCalId: string;
    let linkedId: string;

    async function getBobRange(fromIso: string, toIso: string) {
        const from = Math.floor(new Date(fromIso).getTime() / 1000);
        const to = Math.floor(new Date(toIso).getTime() / 1000);
        const res = await authedRequest(
            testCtx.bob.user.sessionToken,
            `/calendar/${testCtx.bob.user.id}/event-range/${from}/${to}`,
        );
        return assertJson<CalendarEventOccurrence[]>(res);
    }

    beforeAll(async () => {
        testCtx = await getTestContext();
        aliceCalId = findOrFail(
            await assertJson<CalendarItem[]>(
                await authedRequest(testCtx.alice.user.sessionToken, `/calendar/${testCtx.alice.user.id}/calendars`),
            ),
            (c) => c.isDefault,
        ).id;
        bobCalId = findOrFail(
            await assertJson<CalendarItem[]>(
                await authedRequest(testCtx.bob.user.sessionToken, `/calendar/${testCtx.bob.user.id}/calendars`),
            ),
            (c) => c.isDefault,
        ).id;

        await authedRequest(
            testCtx.alice.user.sessionToken,
            `/calendar/${testCtx.alice.user.id}/calendars/${aliceCalId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Etag Series',
                    startTime: '2026-03-02T04:00:00.000Z', // Mar 1 23:00 EST
                    endTime: '2026-03-02T04:50:00.000Z',
                    allDay: false,
                    rrule: 'FREQ=DAILY;COUNT=5',
                    timezone: NY,
                    data: { attendees: [{ email: testCtx.bob.user.email, status: 'pending', role: 'required' }] },
                }),
            },
        );

        const linked = await eventually(
            async () => (await getBobRange('2026-03-01', '2026-03-08')).find((e) => e.title === 'Etag Series'),
            "the series to reach Bob's calendar",
        );
        linkedId = linked.id;
        expect(linked.timezone).toBe(NY);
    });

    test('receiveRsvpForOccurrence stores an etag that includes the timezone', async () => {
        const rsvp = (status: string) =>
            authedRequest(
                testCtx.bob.user.sessionToken,
                `/calendar/${testCtx.bob.user.id}/calendars/${bobCalId}/events/${linkedId}/rsvp`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status, scope: 'this', recurrenceDate: '2026-03-03' }),
                },
            );
        await assertJson(await rsvp('accepted')); // creates the exception
        await assertJson(await rsvp('tentative')); // updates it via the etag-omitting branch

        const home = await getHome(testCtx.bob.user.id);
        const exc = (await home.calendar.getRawEvents(bobCalId)).find((e) => e.parentEventId === linkedId);
        expect(exc).toBeDefined();
        expect(exc!.timezone).toBe(NY); // exception now inherits the parent's timezone
    });

    test('removeThisAndFuture keeps the series timezone', async () => {
        await assertJson(
            await authedRequest(
                testCtx.bob.user.sessionToken,
                `/calendar/${testCtx.bob.user.id}/calendars/${bobCalId}/events/${linkedId}/rsvp`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        status: 'declined',
                        scope: 'this-and-following',
                        remove: true,
                        recurrenceDate: '2026-03-04',
                    }),
                },
            ),
        );
        const home = await getHome(testCtx.bob.user.id);
        const row = (await home.calendar.getRawEvents(bobCalId)).find((e) => e.id === linkedId);
        expect(row).toBeDefined();
        expect(row!.timezone).toBe(NY);
    });
});

// Finding #1 (P1): moving an event between calendars used to be a FE create-then-delete that dropped
// timezone/data and, for a linked event, fired a decline at the organizer. The server owns the move now:
// a calendarId re-home that preserves every field + the row identity, drags exception children along,
// and never runs deleteEvent's iMIP path.
describe('Event move across calendars (finding #1)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let sourceCalId: string;
    let targetCalId: string;

    const eventsUrl = (calId: string) => `/calendar/${ctx.alice.user.id}/calendars/${calId}/events`;
    const rangeUrl = (calId: string, fromIso: string, toIso: string) =>
        `/calendar/${ctx.alice.user.id}/calendars/${calId}/event-range/${Math.floor(
            new Date(fromIso).getTime() / 1000,
        )}/${Math.floor(new Date(toIso).getTime() / 1000)}`;
    const moveUrl = (calId: string, id: string) =>
        `/calendar/${ctx.alice.user.id}/calendars/${calId}/events/${id}/move`;

    beforeAll(async () => {
        ctx = await getTestContext();
        const mk = async (name: string) => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, color: '#4285f4' }),
            });
            return (await assertJson<CalendarItem>(res)).id;
        };
        sourceCalId = await mk('Move Source');
        targetCalId = await mk('Move Target');
    });

    test('re-homes the event preserving timezone, attendees, reminders and recurrence (same id)', async () => {
        const createRes = await authedRequest(ctx.alice.user.sessionToken, eventsUrl(sourceCalId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Movable Rich',
                startTime: '2026-09-01T09:00:00Z',
                endTime: '2026-09-01T10:00:00Z',
                allDay: false,
                timezone: 'America/New_York',
                rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=4',
                data: {
                    attendees: [{ email: 'guest@example.com', name: 'Guest', status: 'pending', role: 'required' }],
                    reminders: [{ type: 'notification', minutes: 15 }],
                },
            }),
        });
        const created = await assertJson<CalendarEvent>(createRes);

        const moveRes = await authedRequest(ctx.alice.user.sessionToken, moveUrl(sourceCalId, created.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetCalendarId: targetCalId }),
        });
        const moved = await assertJson<CalendarEvent>(moveRes);
        expect(moved.id).toBe(created.id); // UPDATE re-home, not create+delete
        expect(moved.calendarId).toBe(targetCalId);
        expect(moved.timezone).toBe('America/New_York');
        expect(moved.rrule!.split(';').sort()).toEqual(['BYDAY=TU', 'COUNT=4', 'FREQ=WEEKLY']);
        expect(moved.data?.attendees?.[0]?.email).toBe('guest@example.com');
        expect(moved.data?.reminders?.[0]?.minutes).toBe(15);

        const targetEvents = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                rangeUrl(targetCalId, '2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z'),
            ),
        );
        expect(targetEvents.some((e) => e.id === created.id)).toBe(true);
        const sourceEvents = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                rangeUrl(sourceCalId, '2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z'),
            ),
        );
        expect(sourceEvents.some((e) => e.id === created.id)).toBe(false);
    });

    test('brings recurrence-exception children along and leaves no orphan rows in the source', async () => {
        const createRes = await authedRequest(ctx.alice.user.sessionToken, eventsUrl(sourceCalId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Movable Series',
                startTime: '2026-10-05T09:00:00Z',
                endTime: '2026-10-05T10:00:00Z',
                allDay: false,
                rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4',
            }),
        });
        const parent = await assertJson<CalendarEvent>(createRes);

        const beforeRange = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                rangeUrl(sourceCalId, '2026-10-01T00:00:00Z', '2026-10-31T23:59:59Z'),
            ),
        );
        const occ = findOrFail(beforeRange, (e) => e.title === 'Movable Series');

        const excRes = await authedRequest(ctx.alice.user.sessionToken, eventsUrl(sourceCalId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Movable Series (modified)',
                startTime: new Date(new Date(occ.startTime).getTime() + 3600_000),
                endTime: new Date(new Date(occ.endTime).getTime() + 3600_000),
                allDay: false,
                parentEventId: parent.id,
                recurrenceDate: occ.occurrenceDate,
            }),
        });
        const exception = await assertJson<CalendarEvent>(excRes);

        const moveRes = await authedRequest(ctx.alice.user.sessionToken, moveUrl(sourceCalId, parent.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetCalendarId: targetCalId }),
        });
        expect(moveRes.status).toBe(200);

        const home = await getHome(ctx.alice.user.id);
        const sourceRows = (await home.calendar.getRawEvents(sourceCalId)).filter((e) => e.uid === parent.uid);
        expect(sourceRows.length).toBe(0);
        const targetRows = (await home.calendar.getRawEvents(targetCalId)).filter((e) => e.uid === parent.uid);
        expect(targetRows.length).toBe(2); // master + its exception child
        expect(targetRows.some((e) => e.id === exception.id && e.parentEventId === parent.id)).toBe(true);

        const targetRange = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                rangeUrl(targetCalId, '2026-10-01T00:00:00Z', '2026-10-31T23:59:59Z'),
            ),
        );
        expect(targetRange.some((e) => e.title === 'Movable Series (modified)')).toBe(true);
        const sourceRange = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                rangeUrl(sourceCalId, '2026-10-01T00:00:00Z', '2026-10-31T23:59:59Z'),
            ),
        );
        expect(sourceRange.some((e) => e.title.startsWith('Movable Series'))).toBe(false);
    });

    test('moving a linked (invited) event does not send an iMIP decline', async () => {
        // A client can't declare itself an invitee (EventDataSchema strips organizer), so seed the linked
        // copy through the domain. External organizer → the decline path would be a sendMail.
        const home = await getHome(ctx.alice.user.id);
        const seedLinked = (title: string, organizer: string, orgEventId: string) =>
            home.calendar.createEvent(sourceCalId, {
                title,
                startTime: new Date('2026-11-02T09:00:00Z'),
                endTime: new Date('2026-11-02T10:00:00Z'),
                allDay: false,
                data: {
                    organizer: { userId: `external_${organizer}`, email: organizer, name: 'Org' },
                    organizerEventId: orgEventId,
                    attendees: [{ email: ctx.alice.user.email, status: 'accepted', role: 'required' }],
                },
            });
        const linked = await seedLinked('Invited Movable', 'org@example.com', 'ext-move-1');
        // Deleting a linked copy DOES decline, so it is the control the move's silence is measured against.
        const control = await seedLinked('Invited Control', 'control@example.com', 'ext-move-control');

        const mailer = await import('../../lib/core/mailer');
        const spy = spyOn(mailer, 'sendMail').mockResolvedValue(true);
        spy.mockClear();

        const moveRes = await authedRequest(ctx.alice.user.sessionToken, moveUrl(sourceCalId, linked.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetCalendarId: targetCalId }),
        });
        const moved = await assertJson<CalendarEvent>(moveRes);

        const removed = await authedRequest(ctx.alice.user.sessionToken, `${eventsUrl(sourceCalId)}/${control.id}`, {
            method: 'DELETE',
        });
        expect(removed.status).toBe(200);
        const mailsTo = (address: string) => spy.mock.calls.filter((c) => c[0].to.some((t) => t.address === address));
        await eventually(
            async () => mailsTo('control@example.com').length || undefined,
            "the control delete's decline",
        );

        expect(mailsTo('org@example.com')).toHaveLength(0);
        spy.mockRestore();

        expect(moved.calendarId).toBe(targetCalId);
        expect(moved.data?.organizer?.email).toBe('org@example.com'); // link preserved across the move
    });

    test('move A→B→A clears the source tombstone: a pre-move sync lists the uri once as 200, never as 404', async () => {
        const createRes = await authedRequest(ctx.alice.user.sessionToken, eventsUrl(sourceCalId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Round Trip',
                startTime: '2027-01-05T09:00:00Z',
                endTime: '2027-01-05T10:00:00Z',
                allDay: false,
            }),
        });
        const created = await assertJson<CalendarEvent>(createRes);
        const uri = created.uri;

        const home = await getHome(ctx.alice.user.id);
        // The client's sync token on the source, captured before it ever leaves.
        const preCtag = (await home.calendar.getCalendarById(sourceCalId))!.ctag;

        await home.calendar.moveEvent(sourceCalId, created.id, targetCalId); // A → B (tombstones the uri in A)
        await home.calendar.moveEvent(targetCalId, created.id, sourceCalId); // B → A (must clear that tombstone)

        const changed = (await home.calendar.getChangedResourcesSince(sourceCalId, preCtag)).filter(
            (r) => r.uri === uri,
        );
        const deleted = (await home.calendar.getDeletedResourcesSince(sourceCalId, preCtag)).filter(
            (d) => d.uri === uri,
        );
        expect(changed).toHaveLength(1); // the re-homed event, once, as a 200
        expect(deleted).toHaveLength(0); // and never as a stale 404
    });

    test('rejects an event that does not live in the given source calendar (404 IDOR)', async () => {
        const createRes = await authedRequest(ctx.alice.user.sessionToken, eventsUrl(targetCalId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Lives In Target',
                startTime: '2026-12-01T09:00:00Z',
                endTime: '2026-12-01T10:00:00Z',
                allDay: false,
            }),
        });
        const created = await assertJson<CalendarEvent>(createRes);

        const res = await authedRequest(ctx.alice.user.sessionToken, moveUrl(sourceCalId, created.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetCalendarId: targetCalId }),
        });
        expect(res.status).toBe(404);
    });

    test('rejects a move to a non-existent target calendar (404)', async () => {
        const createRes = await authedRequest(ctx.alice.user.sessionToken, eventsUrl(sourceCalId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'For Bad Target',
                startTime: '2026-12-05T09:00:00Z',
                endTime: '2026-12-05T10:00:00Z',
                allDay: false,
            }),
        });
        const created = await assertJson<CalendarEvent>(createRes);

        const res = await authedRequest(ctx.alice.user.sessionToken, moveUrl(sourceCalId, created.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetCalendarId: 'no-such-calendar' }),
        });
        expect(res.status).toBe(404);
    });
});

// Finding #2: intervals were never validated on any write path — an all-day event with reversed dates
// (the only UI-reachable case) or a reversed API payload persisted. Enforced once in the domain
// (createEvent/updateEvent) so REST + CalDAV + iMIP all share it. Zero-duration stays legal (RFC 5545).
describe('Calendar interval validation (finding #2)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let calId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        calId = findOrFail(
            await assertJson<CalendarItem[]>(
                await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`),
            ),
            (c) => c.isDefault,
        ).id;
    });

    const url = () => `/calendar/${ctx.alice.user.id}/calendars/${calId}/events`;

    test('create with endTime before startTime returns 400', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, url(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Reversed',
                startTime: '2026-09-01T10:00:00Z',
                endTime: '2026-09-01T09:00:00Z',
                allDay: false,
            }),
        });
        expect(res.status).toBe(400);
    });

    test('create all-day event with reversed dates returns 400', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, url(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Reversed All-Day',
                startTime: '2026-09-16T00:00:00Z',
                endTime: '2026-09-15T00:00:00Z',
                allDay: true,
            }),
        });
        expect(res.status).toBe(400);
    });

    test('update dragging endTime before startTime returns 400', async () => {
        const createRes = await authedRequest(ctx.alice.user.sessionToken, url(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Draggable',
                startTime: '2026-09-01T09:00:00Z',
                endTime: '2026-09-01T10:00:00Z',
                allDay: false,
            }),
        });
        const created = await assertJson<CalendarEvent>(createRes);

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${calId}/events/${created.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endTime: '2026-09-01T08:00:00Z' }),
            },
        );
        expect(res.status).toBe(400);
    });

    test('zero-duration event is accepted (RFC 5545 legal)', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, url(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Instant',
                startTime: '2026-09-01T09:00:00Z',
                endTime: '2026-09-01T09:00:00Z',
                allDay: false,
            }),
        });
        const ev = await assertJson<CalendarEvent>(res);
        expect(new Date(ev.endTime).getTime()).toBe(new Date(ev.startTime).getTime());
    });

    test('valid all-day event (exclusive end = start + 1 day) still creates', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken, url(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Valid All-Day',
                startTime: '2026-09-20T00:00:00Z',
                endTime: '2026-09-21T00:00:00Z',
                allDay: true,
            }),
        });
        expect(res.status).toBe(200);
    });
});

// RFC 4791 § 9.9: a time range names the instances of the recurrence set with its overrides applied, so an
// occurrence someone moved answers in the window it landed in and not in the one it left.
describe('Occurrence moved to another window', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let calId: string;

    async function range(fromIso: string, toIso: string) {
        const from = Math.floor(new Date(fromIso).getTime() / 1000);
        const to = Math.floor(new Date(toIso).getTime() / 1000);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${calId}/event-range/${from}/${to}`,
        );
        return assertJson<CalendarEventOccurrence[]>(res);
    }

    beforeAll(async () => {
        ctx = await getTestContext();
        calId = findOrFail(
            await assertJson<CalendarItem[]>(
                await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`),
            ),
            (c) => c.isDefault,
        ).id;

        const url = `/calendar/${ctx.alice.user.id}/calendars/${calId}/events`;
        const series = await assertJson<CalendarEvent>(
            await authedRequest(ctx.alice.user.sessionToken, url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Relocating Series',
                    startTime: '2026-06-01T09:00:00Z',
                    endTime: '2026-06-01T10:00:00Z',
                    allDay: false,
                    rrule: 'FREQ=WEEKLY;COUNT=4',
                }),
            }),
        );

        await authedRequest(ctx.alice.user.sessionToken, url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Relocated Occurrence',
                startTime: '2026-07-10T09:00:00Z',
                endTime: '2026-07-10T10:00:00Z',
                allDay: false,
                parentEventId: series.id,
                recurrenceDate: '2026-06-08',
            }),
        });
    });

    test('the window it left draws neither the moved occurrence nor the original', async () => {
        const titles = (await range('2026-06-08T00:00:00Z', '2026-06-09T00:00:00Z')).map((e) => e.title);
        expect(titles).not.toContain('Relocated Occurrence');
        expect(titles).not.toContain('Relocating Series');
    });

    test('the window it moved into draws it, keyed by the occurrence it replaces', async () => {
        const events = await range('2026-07-10T00:00:00Z', '2026-07-11T00:00:00Z');
        const moved = findOrFail(events, (e) => e.title === 'Relocated Occurrence');
        expect(new Date(moved.startTime).toISOString()).toBe('2026-07-10T09:00:00.000Z');
        expect(moved.occurrenceDate).toBe('2026-06-08');
    });

    test('the untouched occurrences of the series still answer', async () => {
        const titles = (await range('2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z')).map((e) => e.title);
        expect(titles).toContain('Relocating Series');
    });
});

// What the calendar app's edit dialog sends when the user says "all events in series" from an occurrence it
// already overrode: a PUT to the master carrying the override's own fields, `rrule: null` among them.
describe('A series-wide edit sent from an already-overridden occurrence', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let calId: string;
    let seriesId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        calId = findOrFail(
            await assertJson<CalendarItem[]>(
                await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`),
            ),
            (c) => c.isDefault,
        ).id;
        const series = await assertJson<CalendarEvent>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/calendars/${calId}/events`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: 'Weekly Sync',
                        startTime: '2027-02-01T09:00:00Z',
                        endTime: '2027-02-01T10:00:00Z',
                        allDay: false,
                        rrule: 'FREQ=WEEKLY;COUNT=4',
                    }),
                },
            ),
        );
        seriesId = series.id;
        await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars/${calId}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Moved Sync',
                startTime: '2027-02-08T11:00:00Z',
                endTime: '2027-02-08T12:00:00Z',
                allDay: false,
                rrule: null,
                parentEventId: seriesId,
                recurrenceDate: '2027-02-08',
            }),
        });
    });

    test('a null rrule leaves the series recurring, and the edit reaches every occurrence', async () => {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/calendar/${ctx.alice.user.id}/calendars/${calId}/events/${seriesId}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Moved Sync',
                    startTime: '2027-02-08T11:00:00Z',
                    endTime: '2027-02-08T12:00:00Z',
                    allDay: false,
                    rrule: null,
                }),
            },
        );
        const updated = await assertJson<CalendarEvent>(res);
        expect(updated.rrule).toBe('FREQ=WEEKLY;COUNT=4');

        const from = Math.floor(Date.parse('2027-02-01T00:00:00Z') / 1000);
        const to = Math.floor(Date.parse('2027-04-01T00:00:00Z') / 1000);
        const occurrences = (
            await assertJson<CalendarEventOccurrence[]>(
                await authedRequest(
                    ctx.alice.user.sessionToken,
                    `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
                ),
            )
        ).filter((e) => e.uid === updated.uid);
        expect(occurrences.length).toBeGreaterThan(1);
        expect(occurrences.every((e) => e.title === 'Moved Sync')).toBe(true);
    });
});

// The edit dialog opens on the occurrence the user clicked, so "all events in series" has to apply what changed
// in it relative to the series: the master shifts by the dialog's own delta and keeps the date it started on.
describe('A series-wide edit from a later occurrence', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let calId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        calId = findOrFail(
            await assertJson<CalendarItem[]>(
                await authedRequest(ctx.alice.user.sessionToken, `/calendar/${ctx.alice.user.id}/calendars`),
            ),
            (c) => c.isDefault,
        ).id;
    });

    function eventsUrl() {
        return `/calendar/${ctx.alice.user.id}/calendars/${calId}/events`;
    }

    async function createSeries(title: string): Promise<CalendarEvent> {
        return assertJson<CalendarEvent>(
            await authedRequest(ctx.alice.user.sessionToken, eventsUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    startTime: '2027-03-01T09:00:00Z',
                    endTime: '2027-03-01T10:00:00Z',
                    allDay: false,
                    rrule: 'FREQ=WEEKLY;COUNT=5',
                    timezone: 'UTC',
                }),
            }),
        );
    }

    async function occurrencesOf(uid: string): Promise<CalendarEventOccurrence[]> {
        const from = Math.floor(Date.parse('2027-02-01T00:00:00Z') / 1000);
        const to = Math.floor(Date.parse('2027-05-01T00:00:00Z') / 1000);
        const all = await assertJson<CalendarEventOccurrence[]>(
            await authedRequest(
                ctx.alice.user.sessionToken,
                `/calendar/${ctx.alice.user.id}/event-range/${from}/${to}`,
            ),
        );
        return all.filter((e) => e.uid === uid);
    }

    async function saveSeries(id: string, body: object): Promise<CalendarEvent> {
        return assertJson<CalendarEvent>(
            await authedRequest(ctx.alice.user.sessionToken, `${eventsUrl()}/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
        );
    }

    // The master the dialog reads before it saves, and the fields it opens on the clicked occurrence with.
    async function readMaster(id: string): Promise<Pick<SeriesEdit, 'startTime' | 'endTime'>> {
        const master = await assertJson<CalendarEvent>(
            await authedRequest(ctx.alice.user.sessionToken, `${eventsUrl()}/${id}`),
        );
        return { startTime: new Date(master.startTime), endTime: new Date(master.endTime) };
    }

    function opened(occurrence: CalendarEventOccurrence): SeriesEdit {
        return {
            title: occurrence.title,
            description: occurrence.description,
            location: occurrence.location,
            allDay: occurrence.allDay,
            startTime: new Date(occurrence.startTime),
            endTime: new Date(occurrence.endTime),
        };
    }

    test('a new time of day on a plain occurrence moves every occurrence, the first one included', async () => {
        const series = await createSeries('Team Weekly');
        const clicked = findOrFail(await occurrencesOf(series.uid), (e) => e.occurrenceDate === '2027-03-15');

        const patch = seriesEditFromOccurrence(opened(clicked), await readMaster(series.id), {
            ...opened(clicked),
            startTime: new Date('2027-03-15T11:00:00Z'),
            endTime: new Date('2027-03-15T12:00:00Z'),
        });
        const updated = await saveSeries(series.id, { rrule: clicked.rrule, timezone: 'UTC', ...patch });

        expect(new Date(updated.startTime).toISOString()).toBe('2027-03-01T11:00:00.000Z');
        const after = await occurrencesOf(series.uid);
        expect(after.map((e) => e.occurrenceDate)).toEqual([
            '2027-03-01',
            '2027-03-08',
            '2027-03-15',
            '2027-03-22',
            '2027-03-29',
        ]);
        expect(after.every((e) => new Date(e.startTime).getUTCHours() === 11)).toBe(true);
    });

    test('an overridden occurrence pushes its new time, and not its own title, onto the series', async () => {
        const series = await createSeries('Weekly Standup');
        await authedRequest(ctx.alice.user.sessionToken, eventsUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Solo Edited',
                startTime: '2027-03-15T09:00:00Z',
                endTime: '2027-03-15T10:00:00Z',
                allDay: false,
                parentEventId: series.id,
                recurrenceDate: '2027-03-15',
            }),
        });
        const clicked = findOrFail(await occurrencesOf(series.uid), (e) => e.title === 'Solo Edited');

        // An override carries no rule of its own, so the dialog sends none back.
        const patch = seriesEditFromOccurrence(opened(clicked), await readMaster(series.id), {
            ...opened(clicked),
            startTime: new Date('2027-03-15T11:00:00Z'),
            endTime: new Date('2027-03-15T12:00:00Z'),
        });
        const updated = await saveSeries(series.id, { timezone: 'UTC', ...patch });

        expect(new Date(updated.startTime).toISOString()).toBe('2027-03-01T11:00:00.000Z');
        expect(updated.title).toBe('Weekly Standup');

        const after = await occurrencesOf(series.uid);
        expect(after.map((e) => e.occurrenceDate)).toEqual([
            '2027-03-01',
            '2027-03-08',
            '2027-03-15',
            '2027-03-22',
            '2027-03-29',
        ]);
        const override = findOrFail(after, (e) => e.occurrenceDate === '2027-03-15');
        expect(override.title).toBe('Solo Edited');
        expect(new Date(override.startTime).toISOString()).toBe('2027-03-15T09:00:00.000Z');
    });
});

describe('the calendar byte counter', () => {
    beforeAll(() => {
        rmSync(CALENDAR_TEST_ROOT, { recursive: true, force: true });
    });

    test('two concurrent attendee updates keep both answers, and the byte counter stays exact', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        const created = await harness.instance.createEvent(calendarId, {
            title: 'Standup',
            startTime: new Date('2026-04-01T10:00:00Z'),
            endTime: new Date('2026-04-01T11:00:00Z'),
            allDay: false,
            data: {
                attendees: [
                    { email: 'one@test.local', status: 'pending', role: 'required' },
                    { email: 'two@test.local', status: 'pending', role: 'required' },
                ],
            },
        });

        await Promise.all([
            harness.instance.receiveAttendeeStatus(created.id, 'one@test.local', 'accepted'),
            harness.instance.receiveAttendeeStatus(created.id, 'two@test.local', 'declined'),
        ]);

        const stored = (await harness.instance.getRawEvents(calendarId))[0];
        expect(stored.data?.attendees?.map((a) => a.status).sort()).toEqual(['accepted', 'declined']);
        expect(await harness.instance.size()).toBe(storedBytes(harness.instance));
    });
    test('the byte counter follows the blobs through a write, a replace and a delete', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);

        await putResource(harness.instance, calendarId, 'counted.ics', vcal(vevent('counted@eigen', 'Counted')));
        expect(await harness.instance.size()).toBe(storedBytes(harness.instance));

        await putResource(
            harness.instance,
            calendarId,
            'counted.ics',
            vcal(vevent('counted@eigen', 'Counted', ['DESCRIPTION:Much longer than it was'])),
        );
        expect(await harness.instance.size()).toBe(storedBytes(harness.instance));

        await harness.instance.deleteResource(calendarId, 'counted.ics', { ifMatch: null });
        expect(await harness.instance.size()).toBe(0);
    });
    test('a reopened Home seeds its counter from the blobs it holds', async () => {
        const harness = await makeCalendar();
        const calendarId = await defaultCalendarId(harness);
        await putResource(harness.instance, calendarId, 'seeded.ics', vcal(vevent('seeded@eigen', 'Seeded')));
        const before = await harness.instance.size();

        const restarted = await harness.reopen();
        try {
            expect(await restarted.instance.size()).toBe(before);
            expect(await resourceTextOf(restarted.instance, calendarId, 'seeded.ics')).toContain('SUMMARY:Seeded');
        } finally {
            await restarted.close();
        }
    });

    test('deleting a calendar takes its blobs off the byte counter and its tombstones with it', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const scratch = (await calendar.createCalendar({ name: 'Scratch', color: '#2563eb' })).id;
        const before = await calendar.size();
        await putResource(calendar, scratch, 'a.ics', vcal(vevent('cal-delete-a@eigen', 'A')));
        await putResource(calendar, scratch, 'b.ics', vcal(vevent('cal-delete-b@eigen', 'B')));
        const added = (await calendar.size()) - before;
        expect(added).toBeGreaterThan(0);
        await calendar.deleteResource(scratch, 'b.ics', { ifMatch: null });

        await calendar.deleteCalendar(scratch);

        expect(await calendar.size()).toBe(before);
        expect(await calendar.size()).toBe(storedBytes(calendar));
        // The resources and their event rows went with the row, by cascade.
        expect(calendar.db.select().from(schema.events).all()).toEqual([]);
        // No cascade reaches a tombstone, so a calendar recreated at this id would inherit its 404s.
        expect(calendar.db.select().from(schema.resourceTombstones).all()).toEqual([]);
    });
});

// Every column a blob decides. reindexEvents re-stamps createdAt/updatedAt on a row whose file carries no
// stamp of its own (an exclusion), so a rebuild is compared on what the bytes really own.
const projectedEvents = (calendar: Calendar) => {
    const { createdAt: _created, updatedAt: _updated, ...columns } = getTableColumns(schema.events);
    return calendar.db.select(columns).from(schema.events).all();
};

describe('rebuildProjection', () => {
    test('every event row and projected column comes back from the blobs', async () => {
        const harness = await makeCalendar();
        const calendar = harness.instance;
        const calendarId = await defaultCalendarId(harness);
        // Seeded through the store, because a VEVENT without X-EIGEN-EVENT-ID gets a fresh id on projection.
        await putResource(
            calendar,
            calendarId,
            'series.ics',
            vcal(vevent('rebuild-series@eigen', 'Weekly', ['RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE:20260415T100000Z']), [
                'BEGIN:VEVENT',
                'UID:rebuild-series@eigen',
                'RECURRENCE-ID:20260408T100000Z',
                'DTSTART:20260408T140000Z',
                'DTEND:20260408T150000Z',
                'SUMMARY:Moved occurrence',
                'END:VEVENT',
            ]),
        );
        await putResource(calendar, calendarId, 'plain.ics', vcal(vevent('rebuild-plain@eigen', 'Plain')));
        await putResource(calendar, calendarId, 'deleted.ics', vcal(vevent('rebuild-deleted@eigen', 'Deleted')));
        await calendar.deleteResource(calendarId, 'deleted.ics', { ifMatch: null });

        const resourcesBefore = calendar.db.select().from(schema.resources).all();
        const eventsBefore = projectedEvents(calendar);
        const tombstonesBefore = calendar.db.select().from(schema.resourceTombstones).all();
        expect(tombstonesBefore).toHaveLength(1);
        const ctagBefore = (await calendar.getCollection(calendarId))!.ctag;
        expect(eventsBefore.length).toBeGreaterThan(2);

        // Corrupt every column the blob decides, plus the event rows themselves.
        calendar.db
            .update(schema.resources)
            .set({ uid: sql`'corrupt-' || ${schema.resources.id}`, etag: 'corrupt', hasUnindexedRecurrence: true })
            .run();
        calendar.db.update(schema.events).set({ title: 'corrupt', parentEventId: null, rrule: null }).run();
        calendar.db.delete(schema.events).where(eq(schema.events.uid, 'rebuild-plain@eigen')).run();

        calendar.rebuildProjection();

        expect(calendar.db.select().from(schema.resources).all()).toEqual(resourcesBefore);
        expect(projectedEvents(calendar)).toEqual(eventsBefore);
        // No blob carries a deletion, so a rebuild leaves the tombstone a syncing client still needs.
        expect(calendar.db.select().from(schema.resourceTombstones).all()).toEqual(tombstonesBefore);
        // A rebuild is not a change: no ctag moves, so no client is told to resync.
        expect((await calendar.getCollection(calendarId))!.ctag).toBe(ctagBefore);
    });
});
