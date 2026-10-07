import ICAL from 'ical.js';
import { ApiError } from '../core/errors';
import { parseXml, type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlText } from '../core/xml';
import { DAV_NAMESPACES } from '../dav/xml';
import { asciiLower } from '../dav/xml-node';

const CALDAV = DAV_NAMESPACES.C;

// <C:time-range> bounds are RFC 5545 BASIC format, which `new Date()` reads as Invalid Date and empties the REPORT; RFC 4791 makes them UTC either way.
function parseCalDavDate(value: string): Date | undefined {
    const raw = String(value).trim();
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/.exec(raw);
    const iso = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}Z` : raw;
    try {
        const date = ICAL.Time.fromDateTimeString(iso).toJSDate();
        return Number.isNaN(date.getTime()) ? undefined : date;
    } catch {
        return undefined;
    }
}

const compFilters = (node: XmlElement): XmlElement[] => xmlChildren(node, CALDAV, 'comp-filter');

function named(filters: XmlElement[], name: string): XmlElement | undefined {
    return filters.find((filter) => (xmlAttr(filter, '', 'name') ?? '').toUpperCase() === name);
}

// RFC 4791 § 9.7.5: a substring match, i;ascii-casemap unless the client names i;octet. Another collation narrows nothing.
function uidMatcher(textMatch: XmlElement): ((uid: string) => boolean) | null {
    const text = xmlText(textMatch).trim();
    const negate = xmlAttr(textMatch, '', 'negate-condition') === 'yes';
    const collation = xmlAttr(textMatch, '', 'collation') ?? 'i;ascii-casemap';
    if (collation === 'i;octet') return (uid) => uid.includes(text) !== negate;
    if (collation === 'i;ascii-casemap') return (uid) => asciiLower(uid).includes(asciiLower(text)) !== negate;
    return null;
}

// Only VCALENDAR > VEVENT can match. A UID text-match narrows the rows the report reads; any other prop-filter or text-match is ignored rather than refused: RFC 4791 § 9.7 grammar rides on every UID lookup.
function readFilter(filter: XmlElement | undefined): {
    matchesEvents: boolean;
    timeRange?: { start: Date; end: Date };
    matchesUid?: (uid: string) => boolean;
} {
    if (!filter) return { matchesEvents: true };
    const vcalendar = named(compFilters(filter), 'VCALENDAR');
    if (!vcalendar) return { matchesEvents: compFilters(filter).length === 0 };

    const components = compFilters(vcalendar);
    if (!components.length) return { matchesEvents: true };
    const vevent = named(components, 'VEVENT');
    if (!vevent || xmlChild(vevent, CALDAV, 'is-not-defined')) return { matchesEvents: false };

    const uidMatchers = xmlChildren(vevent, CALDAV, 'prop-filter')
        .filter((prop) => (xmlAttr(prop, '', 'name') ?? '').toUpperCase() === 'UID')
        .map((prop) => xmlChild(prop, CALDAV, 'text-match'))
        .map((textMatch) => (textMatch ? uidMatcher(textMatch) : null))
        .filter((match) => match !== null);

    // The VEVENT's own window only: a range on a nested VALARM filter bounds the alarms, not the events.
    const range = xmlChild(vevent, CALDAV, 'time-range');
    const startAttr = range && xmlAttr(range, '', 'start');
    const endAttr = range && xmlAttr(range, '', 'end');
    const start = startAttr ? parseCalDavDate(startAttr) : undefined;
    const end = endAttr ? parseCalDavDate(endAttr) : undefined;
    // A malformed bound drops the whole range rather than feeding Invalid Date into rrule.between.
    return {
        matchesEvents: true,
        timeRange: start && end ? { start, end } : undefined,
        matchesUid: (uid) => uidMatchers.every((matches) => matches(uid)),
    };
}

export type ReportRequest =
    | {
          type: 'calendar-query';
          matchesEvents: boolean;
          timeRange?: { start: Date; end: Date };
          matchesUid: (uid: string) => boolean;
          wantsData: boolean;
      }
    | { type: 'calendar-multiget'; hrefs: string[]; wantsData: boolean }
    | { type: 'sync-collection'; syncToken?: string; wantsData: boolean };

// A blank body or an unknown root throws: defaulting to calendar-query would dump every event's etag.
export function parseReport(body: Uint8Array): ReportRequest {
    const root = parseXml(body);
    if (!root) throw new ApiError(400, 'Empty REPORT');

    // Decided once here so the three handlers cannot read one request differently.
    const prop = xmlChild(root, 'DAV:', 'prop');
    const wantsData = prop !== undefined && xmlChild(prop, CALDAV, 'calendar-data') !== undefined;

    if (root.ns === CALDAV && root.local === 'calendar-multiget') {
        // Trimmed: a client that indents its body indents inside the href too.
        const hrefs = xmlChildren(root, 'DAV:', 'href').map((href) => xmlText(href).trim());
        return { type: 'calendar-multiget', hrefs, wantsData };
    }
    if (root.ns === 'DAV:' && root.local === 'sync-collection') {
        const token = xmlChild(root, 'DAV:', 'sync-token');
        return { type: 'sync-collection', syncToken: (token && xmlText(token).trim()) || undefined, wantsData };
    }
    if (root.ns === CALDAV && root.local === 'calendar-query') {
        // A filter that names no UID matches every one.
        const filter = readFilter(xmlChild(root, CALDAV, 'filter'));
        return { type: 'calendar-query', matchesUid: () => true, ...filter, wantsData };
    }
    throw new ApiError(400, 'Unsupported REPORT type');
}
