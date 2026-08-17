import type { CalendarEvent, CalendarItem } from '@workspace/lib/types/calendar';
import { calendarHref, eventHref } from './discovery';
import {
    calendarCollectionProps,
    eventEtagProp,
    multistatus,
    propstatOk,
    response,
    XML_CONTENT_TYPE,
} from './xml-builder';

export function handleCalendarPropfind(
    ownerId: string,
    calendar: CalendarItem,
    events: CalendarEvent[],
    depth: string,
): Response {
    const responses: string[] = [
        response(calendarHref(ownerId, calendar.id), [propstatOk(calendarCollectionProps(calendar))]),
    ];

    if (depth === '1') {
        for (const event of events) {
            // Skip exception events (they're part of the master event's .ics)
            if (event.parentEventId) continue;

            responses.push(
                response(eventHref(ownerId, calendar.id, event.uri), [propstatOk(eventEtagProp(event.etag))]),
            );
        }
    }

    return new Response(multistatus(responses), {
        status: 207,
        headers: { 'Content-Type': XML_CONTENT_TYPE },
    });
}

// PROPFIND /dav/calendars/{ownerId}/{calendarId}/{uri} — a single event resource (its own href + etag).
export function handleEventPropfind(ownerId: string, calendarId: string, uri: string, etag: string): Response {
    const xml = multistatus([response(eventHref(ownerId, calendarId, uri), [propstatOk(eventEtagProp(etag))])]);
    return new Response(xml, { status: 207, headers: { 'Content-Type': XML_CONTENT_TYPE } });
}
