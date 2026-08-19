import type { CalendarItem } from '@workspace/lib/types/calendar';
import type { PropMap } from '../dav/propfind';
import { ownershipEntries } from '../dav/xml';
import { escapeXml } from '../shared/xml';

export { PROPFIND_BODY_MAX_BYTES, parsePropfind, selectProps, wantsBrief } from '../dav/propfind';
export {
    davError,
    multistatus,
    multistatusResponse,
    principalProps,
    propstatNotFound,
    propstatOk,
    response,
    XML_CONTENT_TYPE,
} from '../dav/xml';

// For the discovery PROPFIND on /dav/ — returns current-user-principal
export function currentUserPrincipalProp(userId: string): string {
    return `<D:current-user-principal><D:href>/dav/principals/${userId}/</D:href></D:current-user-principal>`;
}

// RFC 6578 token, the calendar ctag stamped into a sync URN. The only two sites allowed to spell the
// grammar — emit/parse drift would 412 every client into a full-resync loop. No generation stamp: unlike the
// carddav twin, the CalDAV index is never rebuilt, so the ctag alone pins a sync point.
export const formatSyncToken = (ctag: number) => `urn:eigen:sync:${ctag}`;

export function parseSyncToken(token: string): { since: number } | null {
    const m = /^urn:eigen:sync:(\d+)$/.exec(token);
    return m ? { since: Number(m[1]) } : null;
}

// The two member fragments, single-sourced so the REPORT view (eventEtagProp) and the PROPFIND row map
// (eventRowProps) can't spell them differently.
const eventGetetag = (etag: string) => `<D:getetag>"${escapeXml(etag)}"</D:getetag>`;
const EVENT_CONTENT_TYPE = `<D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>`;

// Calendar collection properties (for listing calendars)
export function calendarCollectionProps(cal: CalendarItem, ownerId: string): PropMap {
    return new Map([
        ['resourcetype', `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>`],
        ['displayname', `<D:displayname>${escapeXml(cal.name)}</D:displayname>`],
        ...ownershipEntries(ownerId),
        ['calendar-color', `<ICAL:calendar-color>${escapeXml(cal.color)}</ICAL:calendar-color>`],
        ['getctag', `<CS:getctag>${cal.ctag}</CS:getctag>`],
        ['sync-token', `<D:sync-token>${formatSyncToken(cal.ctag)}</D:sync-token>`],
        [
            'supported-calendar-component-set',
            `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>`,
        ],
        // macOS Contacts/Calendar keys on supported-report-set to pick sync-collection and is documented not
        // to fall back when it's missing (spec § 4).
        [
            'supported-report-set',
            `<D:supported-report-set><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report><D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>`,
        ],
    ]);
}

// Event resource properties for REPORT rows (etag + content-type).
export function eventEtagProp(etag: string): string[] {
    return [eventGetetag(etag), EVENT_CONTENT_TYPE];
}

// Event member row for PROPFIND: the REPORT pair plus the empty resourcetype that marks it a non-collection
// member (the RFC 4918 discriminator).
export function eventRowProps(etag: string): PropMap {
    return new Map([
        ['getetag', eventGetetag(etag)],
        ['getcontenttype', EVENT_CONTENT_TYPE],
        ['resourcetype', `<D:resourcetype/>`],
    ]);
}

// Event with calendar-data (used in REPORT responses)
export function calendarDataProp(icsData: string): string {
    return `<C:calendar-data>${escapeXml(icsData)}</C:calendar-data>`;
}

// Home collection — includes discovery props Thunderbird needs at Depth:0
export function homeCollectionProps(userId: string): PropMap {
    return new Map([
        ['resourcetype', `<D:resourcetype><D:collection/></D:resourcetype>`],
        [
            'current-user-principal',
            `<D:current-user-principal><D:href>/dav/principals/${userId}/</D:href></D:current-user-principal>`,
        ],
        ['calendar-home-set', `<C:calendar-home-set><D:href>/dav/calendars/${userId}/</D:href></C:calendar-home-set>`],
        ['displayname', `<D:displayname>Calendars</D:displayname>`],
        ...ownershipEntries(userId),
    ]);
}
