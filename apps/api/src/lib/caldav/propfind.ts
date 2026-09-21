import type { CalendarEvent, CalendarItem } from '@workspace/lib/types/calendar';
import { ICS_CONTENT_TYPE } from '@workspace/lib/types/drive';
import { type PropfindRequest, selectProps } from '../dav/propfind';
import { memberRowProps, multistatusResponse, response } from '../dav/xml';
import { calendarHref, eventHref } from './discovery';
import { calendarCollectionProps } from './xml-builder';

export function handleCalendarPropfind(
    ownerId: string,
    calendar: CalendarItem,
    events: CalendarEvent[],
    depth: string,
    request: PropfindRequest,
    brief: boolean,
): Response {
    const responses: string[] = [
        response(
            calendarHref(ownerId, calendar.id),
            selectProps(calendarCollectionProps(calendar, ownerId), request, brief),
        ),
    ];

    if (depth === '1') {
        for (const event of events) {
            // Skip exception events (they're part of the master event's .ics)
            if (event.parentEventId) continue;

            responses.push(
                response(
                    eventHref(ownerId, calendar.id, event.uri),
                    selectProps(memberRowProps(event.etag, ICS_CONTENT_TYPE), request, brief),
                ),
            );
        }
    }

    return multistatusResponse(responses);
}

// PROPFIND /dav/calendars/{ownerId}/{calendarId}/{uri} — a single event resource (its own href + etag).
export function handleEventPropfind(
    ownerId: string,
    calendarId: string,
    uri: string,
    etag: string,
    request: PropfindRequest,
    brief: boolean,
): Response {
    return multistatusResponse([
        response(
            eventHref(ownerId, calendarId, uri),
            selectProps(memberRowProps(etag, ICS_CONTENT_TYPE), request, brief),
        ),
    ]);
}
