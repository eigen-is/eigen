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

type CompFilter = {
    '@_name'?: string;
    'is-not-defined'?: unknown;
    'comp-filter'?: CompFilter | CompFilter[];
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

// Only VCALENDAR > VEVENT can match, and a prop-filter or text-match the index cannot evaluate is ignored rather than refused: RFC 4791 § 9.7 grammar rides on every UID lookup.
function readFilter(filter: CompFilter | undefined): {
    matchesEvents: boolean;
    timeRange?: { start: Date; end: Date };
} {
    if (!filter) return { matchesEvents: true };
    const vcalendar = named(compFilters(filter), 'VCALENDAR');
    if (!vcalendar) return { matchesEvents: compFilters(filter).length === 0 };

    const components = compFilters(vcalendar);
    if (!components.length) return { matchesEvents: true };
    const vevent = named(components, 'VEVENT');
    if (!vevent || vevent['is-not-defined'] !== undefined) return { matchesEvents: false };

    // The VEVENT's own window only: a range on a nested VALARM filter bounds the alarms, not the events.
    const range = vevent['time-range'];
    const start = range?.['@_start'] ? parseCalDavDate(range['@_start']) : undefined;
    const end = range?.['@_end'] ? parseCalDavDate(range['@_end']) : undefined;
    // A malformed bound drops the whole range rather than feeding Invalid Date into rrule.between.
    return { matchesEvents: true, timeRange: start && end ? { start, end } : undefined };
}

export type ReportRequest =
    | { type: 'calendar-query'; matchesEvents: boolean; timeRange?: { start: Date; end: Date }; wantsData: boolean }
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
