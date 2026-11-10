import { join } from 'node:path';
import type { CalendarEvent } from '@workspace/lib/types/calendar';
import { externalOwnerId } from '@workspace/lib/types/owner';
import { and, eq, sql } from 'drizzle-orm';
import { Calendar } from '../lib/calendar/calendar';
import { toEvent } from '../lib/calendar/mappers';
import * as schema from '../lib/calendar/schema';
import type { ParsedEvent } from '../lib/ical/ical-parse';
import type { TestHome } from './home-test-helpers';
import { makeTestHome } from './home-test-helpers';

// One scratch root per test run, wiped by each test file's beforeAll.
export const CALENDAR_TEST_ROOT = join(import.meta.dir, `../../../../data-test/test-calendar-${Date.now()}`);

// Isolated Calendar instance over a temp home dir — see home-test-helpers.ts for the stub Home under it, and
// `reopen()` on the harness for the restart simulation.
export function makeCalendar(): Promise<TestHome<Calendar>> {
    return makeTestHome((home) => new Calendar(home), CALENDAR_TEST_ROOT);
}

// The stored bytes of a resource, which are the truth every calendar assertion reads.
export async function resourceTextOf(calendar: Calendar, calendarId: string, uri: string): Promise<string> {
    const resource = await calendar.getResource(calendarId, uri);
    if (!resource) throw new Error(`no resource stored at ${calendarId}/${uri}`);
    return new TextDecoder().decode(resource.bytes);
}

// Every row the projection holds for one calendar, overrides and cancelled occurrences included.
export const storedEvents = (calendar: Calendar, calendarId: string): CalendarEvent[] =>
    calendar.joinedEvents().where(eq(schema.events.calendarId, calendarId)).all().map(toEvent);

// One VEVENT's lines, the body a store test PUTs.
export const vevent = (uid: string, summary: string, extra: string[] = []): string[] => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTART:20260401T100000Z',
    'DTEND:20260401T110000Z',
    `SUMMARY:${summary}`,
    ...extra,
    'END:VEVENT',
];

// A DAV PUT carrying no precondition — the shortest way to store a resource.
export const putResource = (calendar: Calendar, calendarId: string, uri: string, body: string) =>
    calendar.putResource(calendarId, uri, body, { ifMatch: null, ifNoneMatch: null });

export async function defaultCalendarId(harness: TestHome<Calendar>): Promise<string> {
    return (await harness.instance.getCalendars())[0].id;
}

export const resourceRowOf = (calendar: Calendar, calendarId: string, uri: string) =>
    calendar.db
        .select()
        .from(schema.resources)
        .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uri, uri)))
        .get()!;

// The bytes the rows really hold, which the running counter must agree with.
export const storedBytes = (calendar: Calendar): number =>
    calendar.db
        .select({ total: sql<number>`COALESCE(SUM(length(${schema.resources.ics})), 0)` })
        .from(schema.resources)
        .get()!.total;

// A REQUEST as inbound mail hands it over: one event, linked by its verified sender and its UID alone.
export const receiveMailed = (calendar: Calendar, parsed: ParsedEvent, sender: string): Promise<void> =>
    calendar.receiveRequest([parsed], {
        organizerEmail: sender,
        organizerEventId: parsed.uid,
        organizerUserId: externalOwnerId(sender),
        createByUserId: externalOwnerId(sender),
    });
