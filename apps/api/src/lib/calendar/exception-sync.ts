import type { CalendarEvent } from '@workspace/lib/types/calendar';
import type { ParsedEvent } from '../caldav/ical-parse';
import type { Calendar } from './calendar';
import { storedRecurrenceKey } from './recurrence';
import type { CalendarEventRow } from './types';

// The recurrence overrides of ONE series, written against a stored master. `seriesEvents` carries that
// UID's VEVENTs and nothing else: a CalDAV PUT holds a single series, but an imported file holds every
// series a calendar has, and a foreign UID's override must not land on this master.
export function syncExceptionEvents(
    calendar: Calendar,
    calendarId: string,
    masterEvent: CalendarEvent,
    seriesEvents: ParsedEvent[],
    userId: string,
) {
    const exceptionParsed = seriesEvents.filter((e) => e.recurrenceDate);

    const existingExceptions = calendar.getExceptionsForParent(masterEvent.id);

    const existingByRecurrenceDate = new Map<string, CalendarEventRow>();
    for (const exc of existingExceptions) {
        const key = exc.recurrenceDate ? storedRecurrenceKey(exc.recurrenceDate) : null;
        if (key) existingByRecurrenceDate.set(key, exc);
    }

    for (const exc of exceptionParsed) {
        const existing = exc.recurrenceDate ? existingByRecurrenceDate.get(exc.recurrenceDate) : null;

        if (existing) {
            calendar.updateEvent(calendarId, existing.id, {
                title: exc.title,
                startTime: exc.startTime,
                endTime: exc.endTime,
                allDay: exc.allDay,
                description: exc.description,
                location: exc.location,
                // Heal legacy tz-null exception rows on re-PUT: without this the update path leaves an
                // already-stored exception at timezone:null, so it never converges (audit #24).
                timezone: exc.timezone ?? masterEvent.timezone,
                status: exc.status,
                // Keep the client's SEQUENCE: GET must echo it (a regression to 0 confuses clients)
                // and the iMIP replay guards compare inbound occurrence updates against it.
                sequence: exc.sequence,
                data: exc.data,
            });
        } else {
            calendar.createEvent(calendarId, {
                title: exc.title,
                startTime: exc.startTime,
                endTime: exc.endTime,
                allDay: exc.allDay,
                description: exc.description,
                location: exc.location,
                // Inherit the master's timezone so the exception serializes in TZID (not Z) form and
                // its etag hashes consistently with the create/update paths (audit #24).
                timezone: exc.timezone ?? masterEvent.timezone,
                status: exc.status,
                sequence: exc.sequence,
                data: exc.data,
                parentEventId: masterEvent.id,
                recurrenceDate: exc.recurrenceDate,
                uid: masterEvent.uid,
                uri: `${masterEvent.uid}-exc-${exc.recurrenceDate}.ics`,
                createByUserId: userId,
            });
        }
    }

    // A CalDAV PUT is a full-resource replace: stored exceptions absent from the payload were
    // removed on the client (e.g. Apple's "undo delete occurrence" re-PUTs the series without the
    // EXDATE). Without the prune the stale canceled row keeps the occurrence hidden forever
    // (audit #D). Only a payload that carries the master VEVENT is a credible full-resource
    // representation — a degenerate master-less PUT proves nothing about the exceptions it omits.
    // Unkeyable legacy rows are inert everywhere, so the replace may drop them too.
    if (!seriesEvents.some((e) => !e.recurrenceDate)) return;
    const parsedKeys = new Set(exceptionParsed.map((e) => e.recurrenceDate));
    const stale = existingExceptions.filter((e) => {
        if (!e.recurrenceDate) return false;
        const key = storedRecurrenceKey(e.recurrenceDate);
        return !key || !parsedKeys.has(key);
    });
    calendar.deleteExceptions(
        calendarId,
        masterEvent.id,
        stale.map((e) => e.id),
    );
}
