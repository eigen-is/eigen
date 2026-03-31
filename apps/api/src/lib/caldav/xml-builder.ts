import type { CalendarItem } from '@workspace/lib/types/calendar';

const NS = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:ICAL="http://apple.com/ns/ical/"`;

export function multistatus(responses: string[]): string {
    return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${NS}>${responses.join('')}</D:multistatus>`;
}

export function response(href: string, propstats: string[]): string {
    return `<D:response><D:href>${escapeXml(href)}</D:href>${propstats.join('')}</D:response>`;
}

export function propstatOk(props: string[]): string {
    return `<D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;
}

export function propstatNotFound(props: string[]): string {
    return `<D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`;
}

// For the discovery PROPFIND on /dav/ — returns current-user-principal
export function currentUserPrincipalProp(userId: string): string {
    return `<D:current-user-principal><D:href>/dav/principals/${userId}/</D:href></D:current-user-principal>`;
}

// For PROPFIND on /dav/principals/{userId}/ — returns calendar-home-set
export function calendarHomeSetProp(userId: string): string {
    return `<C:calendar-home-set><D:href>/dav/calendars/${userId}/</D:href></C:calendar-home-set>`;
}

// Calendar collection properties (for listing calendars)
export function calendarCollectionProps(cal: CalendarItem, _ownerId: string): string[] {
    return [
        `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>`,
        `<D:displayname>${escapeXml(cal.name)}</D:displayname>`,
        `<ICAL:calendar-color>${escapeXml(cal.color)}</ICAL:calendar-color>`,
        `<CS:getctag>${cal.ctag}</CS:getctag>`,
        `<D:sync-token>https://eigen.is/ns/sync/${cal.ctag}</D:sync-token>`,
        `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>`,
    ];
}

// Event resource properties (etag + content-type, used in PROPFIND Depth:1)
export function eventEtagProp(etag: string): string[] {
    return [
        `<D:getetag>"${escapeXml(etag)}"</D:getetag>`,
        `<D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>`,
    ];
}

// Event with calendar-data (used in REPORT responses)
export function calendarDataProp(icsData: string): string {
    return `<C:calendar-data>${escapeXml(icsData)}</C:calendar-data>`;
}

// Home collection (not a calendar, just a collection)
export function homeCollectionProps(): string[] {
    return [`<D:resourcetype><D:collection/></D:resourcetype>`];
}

// Principal properties
export function principalProps(userId: string): string[] {
    return [
        `<D:resourcetype><D:collection/><D:principal/></D:resourcetype>`,
        `<C:calendar-home-set><D:href>/dav/calendars/${userId}/</D:href></C:calendar-home-set>`,
        `<D:principal-URL><D:href>/dav/principals/${userId}/</D:href></D:principal-URL>`,
    ];
}

function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
