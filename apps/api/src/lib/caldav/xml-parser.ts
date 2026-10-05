import { XMLParser } from 'fast-xml-parser';
import ICAL from 'ical.js';

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

// parseTagValue stays off: fxp's numeric coercion mangles digit-only values, like a calendar named `0612`.
export const caldavXmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    isArray: (name) => ['href', 'comp'].includes(name),
});

export type ReportType = 'calendar-query' | 'calendar-multiget' | 'sync-collection';

type TextMatch = string | { '#text'?: string; '@_collation'?: string; '@_negate-condition'?: string };

type PropFilter = { '@_name'?: string; 'text-match'?: TextMatch };

type CompFilter = {
    '@_name'?: string;
    'is-not-defined'?: unknown;
    'comp-filter'?: CompFilter | CompFilter[];
    'prop-filter'?: PropFilter | PropFilter[];
    'time-range'?: { '@_start'?: string; '@_end'?: string };
};

function compFilters(node: CompFilter | undefined): CompFilter[] {
    const nested = node?.['comp-filter'];
    if (!nested) return [];
    return Array.isArray(nested) ? nested : [nested];
}

function named(filters: CompFilter[], name: string): CompFilter | undefined {
    return filters.find((filter) => String(filter['@_name'] ?? '').toUpperCase() === name);
}

const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

// RFC 4791 § 9.7.5: a substring match, i;ascii-casemap unless the client names i;octet. Another collation narrows nothing.
function uidMatcher(textMatch: TextMatch): ((uid: string) => boolean) | null {
    const node = typeof textMatch === 'string' ? { '#text': textMatch } : textMatch;
    const text = String(node['#text'] ?? '');
    const negate = node['@_negate-condition'] === 'yes';
    const collation = node['@_collation'] ?? 'i;ascii-casemap';
    if (collation === 'i;octet') return (uid) => uid.includes(text) !== negate;
    if (collation === 'i;ascii-casemap') return (uid) => asciiLower(uid).includes(asciiLower(text)) !== negate;
    return null;
}

// Only VCALENDAR > VEVENT can match. A UID text-match is answered from the index; any other prop-filter or text-match is ignored rather than refused: RFC 4791 § 9.7 grammar rides on every UID lookup.
function readFilter(filter: CompFilter | undefined): {
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
    if (!vevent || vevent['is-not-defined'] !== undefined) return { matchesEvents: false };

    const props = vevent['prop-filter'];
    const uidMatchers = (Array.isArray(props) ? props : props ? [props] : [])
        .filter((prop) => String(prop['@_name'] ?? '').toUpperCase() === 'UID')
        .map((prop) => (prop['text-match'] === undefined ? null : uidMatcher(prop['text-match'])))
        .filter((match) => match !== null);

    // The VEVENT's own window only: a range on a nested VALARM filter bounds the alarms, not the events.
    const range = vevent['time-range'];
    const start = range?.['@_start'] ? parseCalDavDate(range['@_start']) : undefined;
    const end = range?.['@_end'] ? parseCalDavDate(range['@_end']) : undefined;
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
          matchesUid?: (uid: string) => boolean;
          wantsData: boolean;
      }
    | { type: 'calendar-multiget'; hrefs: string[]; wantsData: boolean }
    | { type: 'sync-collection'; syncToken?: string; wantsData: boolean };

export function parseReport(xml: string): ReportRequest {
    const parsed = caldavXmlParser.parse(xml);

    // An empty body or an unknown root throws: defaulting to calendar-query would dump every event's etag.
    let type: ReportType;
    if (parsed['calendar-query']) type = 'calendar-query';
    else if (parsed['calendar-multiget']) type = 'calendar-multiget';
    else if (parsed['sync-collection']) type = 'sync-collection';
    else throw new Error('Unsupported REPORT type');

    const root = parsed[type];
    // Decided once here so the three handlers cannot read one request differently.
    const wantsData = Object.keys(root['prop'] || {}).some((p) => p.includes('calendar-data'));

    if (type === 'calendar-multiget') {
        const hrefData = root['href'] || [];
        const hrefs = Array.isArray(hrefData) ? hrefData.map(String) : [String(hrefData)].filter(Boolean);
        return { type, hrefs, wantsData };
    }

    if (type === 'sync-collection') {
        const syncToken = root['sync-token'] || undefined;
        return { type, syncToken: syncToken ? String(syncToken) : undefined, wantsData };
    }

    return { type, ...readFilter(root['filter']), wantsData };
}
