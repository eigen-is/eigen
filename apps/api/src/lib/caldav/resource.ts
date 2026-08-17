import type { CalendarEvent } from '@workspace/lib/types/calendar';
import type { Calendar } from '../calendar/calendar';
import { storedRecurrenceKey } from '../calendar/recurrence';
import type { CalendarEventRow } from '../calendar/types';
import { matchesIfMatch, matchesIfNoneMatch } from '../core/http';
import { eventHref } from './discovery';
import type { ParsedEvent } from './ical-parse';
import { parseIcs } from './ical-parse';
import { eventsToIcs } from './ical-serialize';

// A calendar resource runs larger than a vCard (a recurring series carries an overridden VEVENT per exception),
// so the raw-body ceiling is ~4× CardDAV's CARD_MAX_BYTES; the router bounds the PUT body against it before buffering.
export const EVENT_MAX_BYTES = 20_971_520;
// The client-chosen path segment, percent-decoded at the router, becomes the stored uri; cap its decoded length
// as CardDAV's sanitizeCardUri does (an event uri is a DB column here, never a filename).
const MAX_URI_LENGTH = 200;

// GET /dav/calendars/:ownerId/:calendarId/:uri
export function handleGet(masterEvent: CalendarEventRow, allEventsForUid: CalendarEventRow[]): Response {
    const ics = eventsToIcs(allEventsForUid);
    return new Response(ics, {
        status: 200,
        headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            ETag: `"${masterEvent.etag}"`,
        },
    });
}

// PUT /dav/calendars/:ownerId/:calendarId/:uri
export async function handlePut(
    calendar: Calendar,
    ownerId: string,
    calendarId: string,
    uri: string,
    body: string,
    ifMatch: string | null,
    ifNoneMatch: string | null,
    userId: string,
): Promise<Response> {
    if (uri.length > MAX_URI_LENGTH) return new Response('Bad Request', { status: 400 });

    const existingEvent = calendar.getEventByUri(calendarId, uri);
    const currentEtag = existingEvent?.etag ?? null;

    // RFC 7232 preconditions against the state the write overwrites (mirrors CardDAV's putCard): If-None-Match
    // fails when the header matches (e.g. `*` on an existing event), If-Match when it doesn't (a stale token,
    // or any token against a missing resource).
    if (ifNoneMatch !== null && matchesIfNoneMatch(ifNoneMatch, currentEtag)) {
        return new Response('Precondition Failed', { status: 412 });
    }
    if (ifMatch !== null && !matchesIfMatch(ifMatch, currentEtag)) {
        return new Response('Precondition Failed', { status: 412 });
    }

    let events: ReturnType<typeof parseIcs>['events'];
    try {
        ({ events } = parseIcs(body));
    } catch {
        return new Response('Bad Request: invalid iCalendar data', { status: 400 });
    }
    if (!events.length) {
        return new Response('Bad Request: no VEVENT found', { status: 400 });
    }

    // Find the master event (no recurrenceDate)
    const masterParsed = events.find((e) => !e.recurrenceDate) || events[0];

    if (existingEvent) {
        const updatedEvent = calendar.updateEvent(calendarId, existingEvent.id, {
            title: masterParsed.title,
            startTime: masterParsed.startTime,
            endTime: masterParsed.endTime,
            allDay: masterParsed.allDay,
            description: masterParsed.description,
            location: masterParsed.location,
            rrule: masterParsed.rrule,
            timezone: masterParsed.timezone,
            status: masterParsed.status,
            sequence: masterParsed.sequence,
            data: masterParsed.data,
        });

        syncExceptionEvents(calendar, calendarId, updatedEvent, events, userId);

        // Exception sync touches the master's etag — re-read so the response ETag matches storage
        // (a stale ETag would fail the client's next If-Match).
        return new Response(null, {
            status: 204,
            headers: { ETag: `"${calendar.getEventByUri(calendarId, uri)!.etag}"` },
        });
    }

    // Create new event — use UID from ICS and URI from the request path so subsequent GET/DELETE work
    const newEvent = calendar.createEvent(calendarId, {
        title: masterParsed.title,
        startTime: masterParsed.startTime,
        endTime: masterParsed.endTime,
        allDay: masterParsed.allDay,
        description: masterParsed.description,
        location: masterParsed.location,
        rrule: masterParsed.rrule,
        timezone: masterParsed.timezone,
        status: masterParsed.status,
        sequence: masterParsed.sequence,
        data: masterParsed.data,
        createByUserId: userId,
        uid: masterParsed.uid || null,
        uri,
    });

    syncExceptionEvents(calendar, calendarId, newEvent, events, userId);

    return new Response(null, {
        status: 201,
        headers: {
            ETag: `"${calendar.getEventByUri(calendarId, uri)!.etag}"`,
            Location: eventHref(ownerId, calendarId, uri),
        },
    });
}

// DELETE /dav/calendars/:ownerId/:calendarId/:uri
export function handleDelete(calendar: Calendar, calendarId: string, uri: string, ifMatch: string | null): Response {
    const event = calendar.getEventByUri(calendarId, uri);
    if (!event) {
        return new Response('Not Found', { status: 404 });
    }

    if (ifMatch !== null && !matchesIfMatch(ifMatch, event.etag)) {
        return new Response('Precondition Failed', { status: 412 });
    }

    calendar.deleteByUri(calendarId, uri);
    return new Response(null, { status: 204 });
}

function syncExceptionEvents(
    calendar: Calendar,
    calendarId: string,
    masterEvent: CalendarEvent,
    events: ParsedEvent[],
    userId: string,
) {
    const exceptionParsed = events.filter((e) => e.recurrenceDate);

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
    // EXDATE). Without the prune the stale cancelled row keeps the occurrence hidden forever
    // (audit #D). Only a payload that carries the master VEVENT is a credible full-resource
    // representation — a degenerate master-less PUT proves nothing about the exceptions it omits.
    // Unkeyable legacy rows are inert everywhere, so the replace may drop them too.
    if (!events.some((e) => !e.recurrenceDate)) return;
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
