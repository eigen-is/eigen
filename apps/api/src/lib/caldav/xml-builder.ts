import { escapeXml } from '@workspace/lib/html';
import type { CalendarCollection } from '../calendar/resource-store';
import { EVENT_MAX_BYTES } from '../calendar/resource-store';
import { calendarHomeHref } from '../dav/href';
import type { PropMap } from '../dav/propfind';
import { formatSyncToken } from '../dav/sync-token';
import { currentUserPrincipalProp, ownershipEntries } from '../dav/xml';

// Calendar collection properties (for listing calendars)
export function calendarCollectionProps(cal: CalendarCollection, ownerId: string): PropMap {
    return new Map([
        ['resourcetype', `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>`],
        ['displayname', `<D:displayname>${escapeXml(cal.name)}</D:displayname>`],
        ...ownershipEntries(ownerId),
        ['calendar-color', `<ICAL:calendar-color>${escapeXml(cal.color)}</ICAL:calendar-color>`],
        ['getctag', `<CS:getctag>${cal.ctag}</CS:getctag>`],
        ['sync-token', `<D:sync-token>${formatSyncToken(cal)}</D:sync-token>`],
        [
            'supported-calendar-component-set',
            `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>`,
        ],
        // RFC 4791 § 5.2.5 — the ceiling the PUT already enforces, so a client can size a resource first.
        ['max-resource-size', `<C:max-resource-size>${EVENT_MAX_BYTES}</C:max-resource-size>`],
        // macOS Calendar keys on supported-report-set to pick sync-collection and does not fall back when it is missing.
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
