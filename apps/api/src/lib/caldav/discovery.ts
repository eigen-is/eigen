import type { CalendarItem } from '@workspace/lib/types/calendar';
import {
    calendarCollectionProps,
    currentUserPrincipalProp,
    homeCollectionProps,
    multistatus,
    principalProps,
    propstatOk,
    response,
    XML_CONTENT_TYPE,
} from './xml-builder';

// The two href shapes every CalDAV surface emits (discovery, PROPFIND rows, REPORT rows, the PUT Location
// header), so the path shape and the escaping rule live in one place. The resource name is client-chosen, so its
// segment is percent-encoded (the CardDAV twin's cardHref); ownerId and the server-made (randomUUID) calendarId
// are not.
export const calendarHref = (ownerId: string, calendarId: string) => `/dav/calendars/${ownerId}/${calendarId}/`;
export const eventHref = (ownerId: string, calendarId: string, uri: string) =>
    `${calendarHref(ownerId, calendarId)}${encodeURIComponent(uri)}`;

// PROPFIND /dav/ — returns current-user-principal
export function handleRootPropfind(userId: string): Response {
    const xml = multistatus([response('/dav/', [propstatOk([currentUserPrincipalProp(userId)])])]);
    return new Response(xml, { status: 207, headers: { 'Content-Type': XML_CONTENT_TYPE } });
}

// PROPFIND /dav/principals/{userId}/ — returns calendar-home-set + principal props
export function handlePrincipalPropfind(userId: string): Response {
    const xml = multistatus([response(`/dav/principals/${userId}/`, [propstatOk(principalProps(userId))])]);
    return new Response(xml, { status: 207, headers: { 'Content-Type': XML_CONTENT_TYPE } });
}

// PROPFIND /dav/calendars/{ownerId}/ — list calendars (Depth: 0 or 1)
export function handleCalendarHomePropfind(ownerId: string, calendars: CalendarItem[], depth: string): Response {
    const responses: string[] = [
        // The home collection itself
        response(`/dav/calendars/${ownerId}/`, [propstatOk(homeCollectionProps(ownerId))]),
    ];

    if (depth === '1') {
        // Each calendar as a child collection
        for (const cal of calendars) {
            responses.push(response(calendarHref(ownerId, cal.id), [propstatOk(calendarCollectionProps(cal))]));
        }
    }

    const xml = multistatus(responses);
    return new Response(xml, { status: 207, headers: { 'Content-Type': XML_CONTENT_TYPE } });
}
