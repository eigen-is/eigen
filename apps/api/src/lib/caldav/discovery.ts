import type { CalendarItem } from '@workspace/lib/types/calendar';
import { encodePathSegment } from '../dav/href';
import {
    calendarCollectionProps,
    currentUserPrincipalProp,
    homeCollectionProps,
    multistatusResponse,
    principalProps,
    propstatOk,
    response,
} from './xml-builder';

// The two href shapes every CalDAV surface emits (discovery, PROPFIND rows, REPORT rows, the PUT/MKCALENDAR
// Location header), so the path shape and the escaping rule live in one place. The resource name is client-chosen,
// so its segment is minimally path-encoded via the shared dav/href encoder (the CardDAV twin's cardHref); ownerId
// and the calendarId are not — a client-chosen calendarId is charset-restricted by sanitizeCalendarId instead.
export const calendarHref = (ownerId: string, calendarId: string) => `/dav/calendars/${ownerId}/${calendarId}/`;
export const eventHref = (ownerId: string, calendarId: string, uri: string) =>
    `${calendarHref(ownerId, calendarId)}${encodePathSegment(uri)}`;

// A client-chosen calendar id (MKCALENDAR) that is safe to emit raw into an href: calendarHref does not encode
// it, so restrict it to a leading alphanumeric then `A-Za-z0-9._@-` — which excludes `/`, `..`, leading dots and
// control characters — NFC-normalized and capped at 200 chars. Mirrors CardDAV's sanitizeCardUri, minus the
// `.vcf` rule. Returns null on reject.
export function sanitizeCalendarId(raw: string): string | null {
    const id = raw.normalize('NFC');
    const valid = id.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(id);
    return valid ? id : null;
}

// PROPFIND /dav/ — returns current-user-principal
export function handleRootPropfind(userId: string): Response {
    return multistatusResponse([response('/dav/', [propstatOk([currentUserPrincipalProp(userId)])])]);
}

// PROPFIND /dav/principals/{userId}/ — returns calendar-home-set + principal props
export function handlePrincipalPropfind(userId: string): Response {
    return multistatusResponse([response(`/dav/principals/${userId}/`, [propstatOk(principalProps(userId))])]);
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
                response(calendarHref(ownerId, cal.id), [propstatOk(calendarCollectionProps(cal, ownerId))]),
            );
        }
    }

    return multistatusResponse(responses);
}
