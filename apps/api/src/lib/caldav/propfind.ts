import type { CalendarEvent, CalendarItem } from '@workspace/lib/types/calendar';
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
    const calHref = `/dav/calendars/${ownerId}/${calendar.id}/`;
    const responses: string[] = [response(calHref, [propstatOk(calendarCollectionProps(calendar))])];

    if (depth === '1') {
        for (const event of events) {
            // Skip exception events (they're part of the master event's .ics)
            if (event.parentEventId) continue;

            const eventHref = `/dav/calendars/${ownerId}/${calendar.id}/${event.uri}`;
            responses.push(response(eventHref, [propstatOk(eventEtagProp(event.etag))]));
        }
    }

    return new Response(multistatus(responses), {
        status: 207,
        headers: { 'Content-Type': XML_CONTENT_TYPE },
    });
}
