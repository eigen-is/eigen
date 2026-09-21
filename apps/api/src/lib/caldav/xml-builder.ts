import { escapeXml } from '@workspace/lib/html';
import type { CalendarItem } from '@workspace/lib/types/calendar';
import { EVENT_MAX_BYTES } from '../calendar/calendar';
import { calendarHomeHref, principalHref } from '../dav/href';
import type { PropMap } from '../dav/propfind';
import { ownershipEntries } from '../dav/xml';

// The calendar-specific property blocks, and nothing else: the XML envelope, the member props and the
// PROPFIND core are the shared DAV layer's, imported from lib/dav/ where they live. The sync-token grammar
// below is still the calendar's own.

// For the discovery PROPFIND on /dav/ — returns current-user-principal
export function currentUserPrincipalProp(userId: string): string {
    return `<D:current-user-principal><D:href>${principalHref(userId)}</D:href></D:current-user-principal>`;
}

// RFC 6578 token, the calendar ctag stamped into a sync URN. The only two sites allowed to spell the
// grammar — emit/parse drift would send every client into a full-resync loop. No generation stamp: unlike
// the carddav twin, the CalDAV index is never rebuilt, so the ctag alone pins a sync point.
export const formatSyncToken = (ctag: number) => `urn:eigen:sync:${ctag}`;

export function parseSyncToken(token: string): { since: number } | null {
    const m = /^urn:eigen:sync:(\d+)$/.exec(token);
    return m ? { since: Number(m[1]) } : null;
}

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
        // RFC 4791 § 5.2.5 — the ceiling the PUT already enforces, so a client can size a resource first.
        ['max-resource-size', `<C:max-resource-size>${EVENT_MAX_BYTES}</C:max-resource-size>`],
        // macOS Contacts/Calendar keys on supported-report-set to pick sync-collection and is documented not
        // to fall back when it's missing (spec § 4).
        [
            'supported-report-set',
            `<D:supported-report-set><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report><D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>`,
        ],
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
        ['current-user-principal', currentUserPrincipalProp(userId)],
        [
            'calendar-home-set',
            `<C:calendar-home-set><D:href>${calendarHomeHref(userId)}</D:href></C:calendar-home-set>`,
        ],
        ['displayname', `<D:displayname>Calendars</D:displayname>`],
        ...ownershipEntries(userId),
    ]);
}
