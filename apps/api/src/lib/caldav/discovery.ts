import type { CalendarItem } from '@workspace/lib/types/calendar';
import {
    calendarCollectionProps,
    currentUserPrincipalProp,
    homeCollectionProps,
    multistatus,
    principalProps,
    propstatOk,
    response,
} from './xml-builder';

const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';

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
            responses.push(
                response(`/dav/calendars/${ownerId}/${cal.id}/`, [propstatOk(calendarCollectionProps(cal))]),
            );
        }
    }

    const xml = multistatus(responses);
    return new Response(xml, { status: 207, headers: { 'Content-Type': XML_CONTENT_TYPE } });
}
