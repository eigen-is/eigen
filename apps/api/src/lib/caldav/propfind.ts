import { ICS_CONTENT_TYPE } from '@workspace/lib/types/drive';
import type { ResourceRow } from '../calendar/dav-store';
import type { CalendarCollection } from '../calendar/resource-store';
import { type PropfindRequest, selectProps } from '../dav/propfind';
import { memberRowProps, multistatusResponse, response } from '../dav/xml';
import { calendarHref, eventHref } from './discovery';
import { calendarCollectionProps } from './xml-builder';

export function handleCalendarPropfind(
    ownerId: string,
    calendar: CalendarCollection,
    resources: ResourceRow[],
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
        for (const resource of resources) {
            responses.push(
                response(
                    eventHref(ownerId, calendar.id, resource.uri),
                    selectProps(memberRowProps(resource.etag, ICS_CONTENT_TYPE), request, brief),
                ),
            );
        }
    }

    return multistatusResponse(responses);
}

// PROPFIND /dav/calendars/{ownerId}/{calendarId}/{uri} — a single resource (its own href + etag).
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
