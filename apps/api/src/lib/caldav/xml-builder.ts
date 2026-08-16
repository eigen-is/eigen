import type { CalendarItem } from '@workspace/lib/types/calendar';
import { escapeXml } from '../shared/xml';

export const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';

const NS = `xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CARD="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/" xmlns:ICAL="http://apple.com/ns/ical/"`;

export function multistatus(responses: string[], extra?: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${NS}>${responses.join('')}${extra ?? ''}</D:multistatus>`;
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

// Calendar collection properties (for listing calendars)
export function calendarCollectionProps(cal: CalendarItem): string[] {
    return [
        `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>`,
        `<D:displayname>${escapeXml(cal.name)}</D:displayname>`,
        `<ICAL:calendar-color>${escapeXml(cal.color)}</ICAL:calendar-color>`,
        `<CS:getctag>${cal.ctag}</CS:getctag>`,
        `<D:sync-token>urn:eigen:sync:${cal.ctag}</D:sync-token>`,
        `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>`,
        // macOS Contacts/Calendar keys on supported-report-set to pick sync-collection and is documented not
        // to fall back when it's missing (spec § 4, CalDAV broken window #1).
        `<D:supported-report-set><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report><D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>`,
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

// Home collection — includes discovery props Thunderbird needs at Depth:0
export function homeCollectionProps(userId: string): string[] {
    return [
        `<D:resourcetype><D:collection/></D:resourcetype>`,
        `<D:current-user-principal><D:href>/dav/principals/${userId}/</D:href></D:current-user-principal>`,
        `<C:calendar-home-set><D:href>/dav/calendars/${userId}/</D:href></C:calendar-home-set>`,
        `<D:displayname>Calendars</D:displayname>`,
    ];
}

// Principal properties
export function principalProps(userId: string): string[] {
    return [
        `<D:resourcetype><D:collection/><D:principal/></D:resourcetype>`,
        `<C:calendar-home-set><D:href>/dav/calendars/${userId}/</D:href></C:calendar-home-set>`,
        // One principal serves both protocols; clients read only the props they know (spec § 4).
        `<CARD:addressbook-home-set><D:href>/dav/addressbooks/${userId}/</D:href></CARD:addressbook-home-set>`,
        `<D:principal-URL><D:href>/dav/principals/${userId}/</D:href></D:principal-URL>`,
    ];
}
