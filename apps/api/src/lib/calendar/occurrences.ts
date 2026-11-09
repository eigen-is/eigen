// The occurrences a calendar shows in a time window: single events as stored, each series expanded in memory,
// and the overrides in place of the occurrences they replace. Readers such as the range routes and a CalDAV
// time-range REPORT go through getEventsInRange. An override answers from its own times (RFC 4791 § 9.9), so
// moving one carries it out of the window it was expanded in.

import { occurrenceDateToString } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Calendar } from './calendar';
import { toEvent } from './mappers';
import { expandRecurrence } from './recurrence';
import * as schema from './schema';

// Bounds one series' expansion against a year-9999 span. Cut rather than refused, so a wide CalDAV sync gets data.
const MAX_EXPANSION_MS = 5 * 366 * 24 * 60 * 60 * 1000;

export async function getEventsInRange(
    calendar: Calendar,
    from: Date,
    to: Date,
    calendarId?: string,
): Promise<CalendarEventOccurrence[]> {
    const scoped = calendarId ? [eq(schema.events.calendarId, calendarId)] : [];
    const overlaps = and(lte(schema.events.startTime, to), gte(schema.events.endTime, from));

    const nonRecurring = calendar
        .joinedEvents()
        .where(and(...scoped, isNull(schema.events.rrule), isNull(schema.events.parentEventId), overlaps))
        .all()
        .map(toEvent);

    // A series starting after the window has no occurrence inside it; rrule never steps back before DTSTART.
    const isMasterInWindow = and(
        sql`${schema.events.rrule} IS NOT NULL`,
        isNull(schema.events.parentEventId),
        lte(schema.events.startTime, to),
    );
    const recurring = calendar
        .joinedEvents()
        .where(and(...scoped, isMasterInWindow))
        .all()
        .map(toEvent);

    // An override is read twice: as the occurrence it replaces, and where it was moved to when its own times overlap.
    // The parents ride as a subquery: one bound variable per master would pass SQLite's cap on a large home.
    const masterIds = calendar.db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(and(...scoped, isMasterInWindow));
    const exceptions = calendar
        .joinedEvents()
        .where(
            and(
                ...scoped,
                sql`${schema.events.parentEventId} IS NOT NULL`,
                or(inArray(schema.events.parentEventId, masterIds), overlaps),
            ),
        )
        .all()
        .map(toEvent);

    const replacedByParent = new Map<string, Set<string>>();
    for (const { recurrenceDate, parentEventId } of exceptions) {
        if (!recurrenceDate || !parentEventId) continue;
        const keys = replacedByParent.get(parentEventId) ?? new Set<string>();
        replacedByParent.set(parentEventId, keys);
        keys.add(recurrenceDate);
    }

    const results: CalendarEventOccurrence[] = [];
    for (const event of nonRecurring) {
        results.push({ ...event, occurrenceDate: occurrenceDateToString(event.startTime) });
    }

    for (const event of recurring) {
        const replaced = replacedByParent.get(event.id);
        // An occurrence that began before the window and still runs is in it, as a single event is.
        const opened = from.getTime() - (event.endTime.getTime() - event.startTime.getTime());
        const start = new Date(Math.max(event.startTime.getTime(), opened));
        const end = new Date(Math.min(to.getTime(), start.getTime() + MAX_EXPANSION_MS));
        for (const occurrence of expandRecurrence(event, start, end)) {
            if (!replaced?.has(occurrence.occurrenceDate)) results.push(occurrence);
        }
    }

    for (const exception of exceptions) {
        if (exception.status === 'cancelled') continue;
        if (exception.startTime > to || exception.endTime < from) continue;
        // The stored key, not the moved startTime: the FE round-trips occurrenceDate into scope='this' RSVPs.
        if (exception.recurrenceDate) results.push({ ...exception, occurrenceDate: exception.recurrenceDate });
    }

    results.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    return results;
}

// The resources a window touches: one matches when an occurrence of it does.
export async function getResourceUrisInRange(
    calendar: Calendar,
    calendarId: string,
    from: Date,
    to: Date,
): Promise<Set<string>> {
    const occurrences = await getEventsInRange(calendar, from, to, calendarId);
    return new Set(occurrences.map((occurrence) => occurrence.uri));
}
