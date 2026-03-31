import type { CalendarEvent } from '@workspace/lib/types/calendar';
import type { Calendar, CalendarEventRow } from '../calendar/calendar';
import { parseIcs } from './ical-parse';
import { eventsToIcs } from './ical-serialize';

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
    const existingEvent = calendar.getEventByUri(calendarId, uri);

    // If-None-Match: * means "create only, fail if exists"
    if (ifNoneMatch === '*' && existingEvent) {
        return new Response('Precondition Failed', { status: 412 });
    }

    // If-Match: "etag" means "update only if etag matches"
    if (ifMatch && existingEvent) {
        const cleanEtag = ifMatch.replace(/"/g, '');
        if (existingEvent.etag !== cleanEtag) {
            return new Response('Precondition Failed', { status: 412 });
        }
    }

    let parsed: ReturnType<typeof parseIcs>;
    try {
        parsed = parseIcs(body);
    } catch {
        return new Response('Bad Request: invalid iCalendar data', { status: 400 });
    }
    if (!parsed.length) {
        return new Response('Bad Request: no VEVENT found', { status: 400 });
    }

    // Find the master event (no recurrenceDate)
    const masterParsed = parsed.find((e) => !e.recurrenceDate) || parsed[0];

    if (existingEvent) {
        // Update existing event
        calendar.updateEvent(existingEvent.id, {
            title: masterParsed.title,
            startTime: masterParsed.startTime,
            endTime: masterParsed.endTime,
            allDay: masterParsed.allDay,
            description: masterParsed.description,
            location: masterParsed.location,
            rrule: masterParsed.rrule,
            timezone: masterParsed.timezone,
            status: masterParsed.status,
            data: masterParsed.data,
        });

        const updatedEvent = calendar.getEventByUri(calendarId, uri)!;
        syncExceptionEvents(calendar, calendarId, updatedEvent, parsed, userId);

        return new Response(null, {
            status: 204,
            headers: { ETag: `"${updatedEvent?.etag || ''}"` },
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
        data: masterParsed.data,
        createByUserId: userId,
        uid: masterParsed.uid || null,
        uri,
    });

    syncExceptionEvents(calendar, calendarId, newEvent, parsed, userId);

    return new Response(null, {
        status: 201,
        headers: {
            ETag: `"${newEvent.etag}"`,
            Location: `/dav/calendars/${ownerId}/${calendarId}/${uri}`,
        },
    });
}

// DELETE /dav/calendars/:ownerId/:calendarId/:uri
export function handleDelete(calendar: Calendar, calendarId: string, uri: string, ifMatch: string | null): Response {
    const event = calendar.getEventByUri(calendarId, uri);
    if (!event) {
        return new Response('Not Found', { status: 404 });
    }

    if (ifMatch) {
        const cleanEtag = ifMatch.replace(/"/g, '');
        if (event.etag !== cleanEtag) {
            return new Response('Precondition Failed', { status: 412 });
        }
    }

    calendar.deleteByUri(calendarId, uri);
    return new Response(null, { status: 204 });
}

function syncExceptionEvents(
    calendar: Calendar,
    calendarId: string,
    masterEvent: CalendarEvent,
    parsed: ReturnType<typeof parseIcs>,
    userId: string,
) {
    const exceptionParsed = parsed.filter((e) => e.recurrenceDate);
    if (!exceptionParsed.length) return;

    const existingExceptions = calendar.getRawEvents(calendarId).filter((e) => e.parentEventId === masterEvent.id);

    const existingByRecurrenceDate = new Map<string, CalendarEventRow>();
    for (const exc of existingExceptions) {
        if (exc.recurrenceDate) {
            existingByRecurrenceDate.set(exc.recurrenceDate, exc);
        }
    }

    for (const exc of exceptionParsed) {
        const existing = exc.recurrenceDate ? existingByRecurrenceDate.get(exc.recurrenceDate) : null;

        if (existing) {
            calendar.updateEvent(existing.id, {
                title: exc.title,
                startTime: exc.startTime,
                endTime: exc.endTime,
                allDay: exc.allDay,
                description: exc.description,
                location: exc.location,
                status: exc.status,
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
                status: exc.status,
                data: exc.data,
                parentEventId: masterEvent.id,
                recurrenceDate: exc.recurrenceDate,
                uid: masterEvent.uid,
                uri: `${masterEvent.uid}-exc-${exc.recurrenceDate}.ics`,
                createByUserId: userId,
            });
        }
    }
}
