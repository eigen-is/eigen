import { occurrenceDateToString } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { storedRecurrenceKey } from '../ical/wall-clock';
import type { Calendar } from './calendar';
import { toEvent } from './mappers';
import { expandRecurrence } from './recurrence';
import * as schema from './schema';

// An override answers from its own times (RFC 4791 § 9.9), so moving one carries it out of the window it was expanded in.

// 5 years bounds rrule iteration against a year-9999 span; clamp rather than reject so a wide CalDAV sync still gets bounded data.
const MAX_RANGE_SPAN_MS = 5 * 366 * 24 * 60 * 60 * 1000;

function clampRangeEnd(from: Date, to: Date): Date {
    const maxEnd = from.getTime() + MAX_RANGE_SPAN_MS;
    return to.getTime() > maxEnd ? new Date(maxEnd) : to;
}

export async function getEventsInRange(
    calendar: Calendar,
    from: Date,
    to: Date,
    calendarId?: string,
): Promise<CalendarEventOccurrence[]> {
    const clampedTo = clampRangeEnd(from, to);
    await calendar.gate.ensureDrained();

    const scoped = calendarId ? [eq(schema.events.calendarId, calendarId)] : [];
    const overlaps = and(lte(schema.events.startTime, clampedTo), gte(schema.events.endTime, from));

    const nonRecurring = calendar
        .joinedEvents()
        .where(and(...scoped, isNull(schema.events.rrule), isNull(schema.events.parentEventId), overlaps))
        .all()
        .map(toEvent);

    // A series starting after the window has no occurrence inside it; rrule never steps back before DTSTART.
    const recurring = calendar
        .joinedEvents()
        .where(
            and(
                ...scoped,
                sql`${schema.events.rrule} IS NOT NULL`,
                isNull(schema.events.parentEventId),
                lte(schema.events.startTime, clampedTo),
            ),
        )
        .all()
        .map(toEvent);

    // An override is read twice: as the parent occurrence it replaces, and — when its own times overlap — where it was moved to.
    const parentIds = recurring.map((event) => event.id);
    const exceptions = calendar
        .joinedEvents()
        .where(
            and(
                ...scoped,
                sql`${schema.events.parentEventId} IS NOT NULL`,
                or(parentIds.length > 0 ? inArray(schema.events.parentEventId, parentIds) : undefined, overlaps),
            ),
        )
        .all()
        .map(toEvent);

    const replacedByParent = new Map<string, Set<string>>();
    for (const exception of exceptions) {
        const dateKey = exception.recurrenceDate ? storedRecurrenceKey(exception.recurrenceDate) : null;
        if (!dateKey || !exception.parentEventId) continue;
        const keys = replacedByParent.get(exception.parentEventId) ?? new Set<string>();
        replacedByParent.set(exception.parentEventId, keys);
        keys.add(dateKey);
    }

    const results: CalendarEventOccurrence[] = [];
    for (const event of nonRecurring) {
        results.push({ ...event, occurrenceDate: occurrenceDateToString(event.startTime) });
    }

    for (const event of recurring) {
        const replaced = replacedByParent.get(event.id);
        for (const occurrence of expandRecurrence(event, from, clampedTo)) {
            if (!replaced?.has(occurrence.occurrenceDate)) results.push(occurrence);
        }
    }

    for (const exception of exceptions) {
        if (exception.status === 'cancelled') continue;
        if (exception.startTime > clampedTo || exception.endTime < from) continue;
        // The stored key, not the moved startTime: the FE round-trips occurrenceDate into scope='this' RSVPs.
        const dateKey = exception.recurrenceDate ? storedRecurrenceKey(exception.recurrenceDate) : null;
        if (dateKey) results.push({ ...exception, occurrenceDate: dateKey });
    }

    results.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    return results;
}

// The files a window touches: a resource matches when an occurrence of it does.
export async function getResourceUrisInRange(
    calendar: Calendar,
    calendarId: string,
    from: Date,
    to: Date,
): Promise<Set<string>> {
    const occurrences = await getEventsInRange(calendar, from, to, calendarId);
    return new Set(occurrences.map((occurrence) => occurrence.uri));
}
