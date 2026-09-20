import { ICS_MIME } from '@workspace/lib/types/drive';
import type { Calendar } from '../calendar/calendar';
import { syncExceptionEvents } from '../calendar/exception-sync';
import type { CalendarEventRow } from '../calendar/types';
import { matchesIfMatch, matchesIfNoneMatch } from '../core/http';
import { eventHref } from './discovery';
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
            'Content-Type': `${ICS_MIME}; charset=utf-8`,
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
    const currentEtag = existingEvent ? `"${existingEvent.etag}"` : null;

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
    // One resource is one series, so this is every VEVENT in a well-formed payload — and the one
    // filter that keeps a multi-UID payload from hanging foreign overrides off this master.
    const seriesEvents = events.filter((e) => e.uid === masterParsed.uid);

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

        syncExceptionEvents(calendar, calendarId, updatedEvent, seriesEvents, userId);

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

    syncExceptionEvents(calendar, calendarId, newEvent, seriesEvents, userId);

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

    if (ifMatch !== null && !matchesIfMatch(ifMatch, `"${event.etag}"`)) {
        return new Response('Precondition Failed', { status: 412 });
    }

    calendar.deleteByUri(calendarId, uri);
    return new Response(null, { status: 204 });
}
