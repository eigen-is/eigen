import { occurrenceDateToString } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent, CalendarEventOccurrence } from '@workspace/lib/types/calendar';
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { clampRangeEnd } from '../ical/recurrence-limits';
import { storedRecurrenceKey } from '../ical/wall-clock';
import type { Calendar } from './calendar';
import { toEvent } from './mappers';
import { expandRecurrence } from './recurrence';
import * as schema from './schema';

// The range reads over the Calendar facade: the stored rows a span touches, and the occurrences the
// recurring ones among them expand to once their exceptions are folded in.

export async function getRawEventsInRange(
    calendar: Calendar,
    calendarId: string,
    from: Date,
    to: Date,
): Promise<CalendarEvent[]> {
    // Clamp the span (see recurrence-limits) so an over-wide CalDAV time-range cannot block the event loop.
    const clampedTo = clampRangeEnd(from, to);
    await calendar.gate.ensureDrained();

    const nonRecurring = calendar
        .joinedEvents()
        .where(
            and(
                eq(schema.events.calendarId, calendarId),
                isNull(schema.events.rrule),
                isNull(schema.events.parentEventId),
                lte(schema.events.startTime, clampedTo),
                gte(schema.events.endTime, from),
            ),
        )
        .all()
        .map(toEvent);

    const matching: CalendarEvent[] = [];
    const matchingIds = new Set<string>();
    for (const row of calendar
        .joinedEvents()
        .where(
            and(
                eq(schema.events.calendarId, calendarId),
                sql`${schema.events.rrule} IS NOT NULL`,
                isNull(schema.events.parentEventId),
            ),
        )
        .all()) {
        const event = toEvent(row);
        if (expandRecurrence(event, from, clampedTo).length > 0) {
            matching.push(event);
            matchingIds.add(event.id);
        }
    }

    const exceptions: CalendarEvent[] = [];
    if (matchingIds.size > 0) {
        for (const row of calendar
            .joinedEvents()
            .where(and(eq(schema.events.calendarId, calendarId), sql`${schema.events.parentEventId} IS NOT NULL`))
            .all()) {
            const event = toEvent(row);
            if (event.parentEventId && matchingIds.has(event.parentEventId)) exceptions.push(event);
        }
    }

    return [...nonRecurring, ...matching, ...exceptions];
}

export async function getEventsInRange(
    calendar: Calendar,
    from: Date,
    to: Date,
    calendarId?: string,
): Promise<CalendarEventOccurrence[]> {
    // Clamp the span (see recurrence-limits) so an over-wide range cannot materialise a giant occurrence set.
    const clampedTo = clampRangeEnd(from, to);
    await calendar.gate.ensureDrained();

    const scoped = calendarId ? [eq(schema.events.calendarId, calendarId)] : [];

    const nonRecurring = calendar
        .joinedEvents()
        .where(
            and(
                ...scoped,
                isNull(schema.events.rrule),
                isNull(schema.events.parentEventId),
                lte(schema.events.startTime, clampedTo),
                gte(schema.events.endTime, from),
            ),
        )
        .all()
        .map(toEvent);

    const recurring = calendar
        .joinedEvents()
        .where(and(...scoped, sql`${schema.events.rrule} IS NOT NULL`, isNull(schema.events.parentEventId)))
        .all()
        .map(toEvent);

    const exceptionsByParent = new Map<string, CalendarEvent[]>();
    for (const row of calendar
        .joinedEvents()
        .where(and(...scoped, sql`${schema.events.parentEventId} IS NOT NULL`))
        .all()) {
        const event = toEvent(row);
        const group = exceptionsByParent.get(event.parentEventId!) ?? [];
        exceptionsByParent.set(event.parentEventId!, group);
        group.push(event);
    }

    const results: CalendarEventOccurrence[] = [];
    for (const event of nonRecurring) {
        results.push({ ...event, occurrenceDate: occurrenceDateToString(event.startTime) });
    }

    for (const event of recurring) {
        const cancelledDates = new Set<string>();
        const modifiedDates = new Map<string, CalendarEvent>();
        for (const exception of exceptionsByParent.get(event.id) ?? []) {
            const dateKey = exception.recurrenceDate ? storedRecurrenceKey(exception.recurrenceDate) : null;
            if (!dateKey) continue;
            if (exception.status === 'cancelled') cancelledDates.add(dateKey);
            else modifiedDates.set(dateKey, exception);
        }

        for (const occurrence of expandRecurrence(event, from, clampedTo)) {
            if (cancelledDates.has(occurrence.occurrenceDate)) continue;
            const modified = modifiedDates.get(occurrence.occurrenceDate);
            // The stored key, not the moved startTime: the FE round-trips occurrenceDate into scope='this' RSVPs.
            results.push(modified ? { ...modified, occurrenceDate: occurrence.occurrenceDate } : occurrence);
        }
    }

    results.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    return results;
}
