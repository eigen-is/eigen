import type { CalendarCollection } from '../calendar/resource-store';
import { calendarHomeHref, encodePathSegment, principalHref } from '../dav/href';
import { type PropfindRequest, selectProps } from '../dav/propfind';
import { currentUserPrincipalProp, multistatusResponse, principalProps, propstatOk, response } from '../dav/xml';
import { calendarCollectionProps, homeCollectionProps } from './xml-builder';

// Only the client-chosen resource name needs path encoding; a calendarId is charset-restricted by sanitizeCalendarId.
export const calendarHref = (ownerId: string, calendarId: string) => `/dav/calendars/${ownerId}/${calendarId}/`;
export const eventHref = (ownerId: string, calendarId: string, uri: string) =>
    `${calendarHref(ownerId, calendarId)}${encodePathSegment(uri)}`;

// PROPFIND /dav/ — returns current-user-principal
export function handleRootPropfind(userId: string): Response {
    return multistatusResponse([response('/dav/', [propstatOk([currentUserPrincipalProp(userId)])])]);
}

// PROPFIND /dav/principals/{userId}/ — returns calendar-home-set + principal props
export function handlePrincipalPropfind(userId: string): Response {
    return multistatusResponse([response(principalHref(userId), [propstatOk(principalProps(userId))])]);
}

// PROPFIND /dav/calendars/{ownerId}/ — list calendars (Depth: 0 or 1)
export function handleCalendarHomePropfind(
    ownerId: string,
    calendars: CalendarCollection[],
    depth: string,
    request: PropfindRequest,
    brief: boolean,
): Response {
    const responses: string[] = [
        // The home collection itself
        response(calendarHomeHref(ownerId), selectProps(homeCollectionProps(ownerId), request, brief)),
    ];

    if (depth === '1') {
        // Each calendar as a child collection
        for (const cal of calendars) {
            responses.push(
                response(
                    calendarHref(ownerId, cal.id),
                    selectProps(calendarCollectionProps(cal, ownerId), request, brief),
                ),
            );
        }
    }

    return multistatusResponse(responses);
}
