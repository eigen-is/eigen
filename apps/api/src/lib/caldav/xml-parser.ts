import { XMLParser } from 'fast-xml-parser';
import ICAL from 'ical.js';

// CalDAV <C:time-range> bounds are RFC 5545 BASIC format (YYYYMMDD or YYYYMMDDTHHMMSS[Z]). `new Date()`
// only reads EXTENDED ISO and returns Invalid Date on basic input, which then flows into
// rrule.between(Invalid, Invalid) and silently empties (or crashes) the REPORT. Normalize basic →
// extended UTC and let ical.js — the domain's ICS date parser — parse and validate it. RFC 4791
// mandates UTC for these bounds, so a missing/present `Z` is treated as UTC either way. Returns
// undefined for anything malformed so the caller drops the range instead of passing NaN downstream.
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

// One parser for every CalDAV request body, REPORT and PROPPATCH alike: fxp's default numeric coercion
// mangles digit-only values (a calendar named `0612`, the carddav twin's <text-match> phone bug).
export const caldavXmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    parseTagValue: false,
    isArray: (name) => ['href', 'comp'].includes(name),
});

export type ReportType = 'calendar-query' | 'calendar-multiget' | 'sync-collection';

// One <comp-filter> as fast-xml-parser hands it over: its name, whether it asks for the component to be
// absent, what it nests, and the window it bounds.
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

// What a calendar-query selects. Eigen stores VEVENTs, so only VCALENDAR > VEVENT can match anything: a
// VTODO, VJOURNAL or VFREEBUSY filter matches nothing at all rather than every event in the collection,
// and so does a VEVENT filter that asks for the component to be absent. A prop-filter, param-filter or
// text-match the index cannot evaluate is ignored: they are mandatory grammar (RFC 4791 § 9.7) and every
// client that looks an event up by UID sends one, so refusing them refuses the whole collection.
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
    // Only a fully-valid range is honored; a malformed bound drops the range (→ full listing) rather
    // than feeding Invalid Date into rrule.between.
    return { matchesEvents: true, timeRange: start && end ? { start, end } : undefined };
}

// Discriminated union, the CardDAV twin's shape (carddav xml-parser.ts): each report type carries only the
// fields it uses, so a handler taking Extract<ReportRequest, {type}> can't read a field meant for another.
export type ReportRequest =
    | { type: 'calendar-query'; matchesEvents: boolean; timeRange?: { start: Date; end: Date }; wantsData: boolean }
    | { type: 'calendar-multiget'; hrefs: string[]; wantsData: boolean }
    | { type: 'sync-collection'; syncToken?: string; wantsData: boolean };

export function parseReport(xml: string): ReportRequest {
    const parsed = caldavXmlParser.parse(xml);

    // removeNSPrefix strips the D:/C: prefixes, so a report's root is always unprefixed — no fallback needed.
    // An empty body or an unknown root matches nothing and throws: a bodyless or unknown REPORT must 400,
    // never default to a calendar-query that dumps every event's etag (the report.ts contract, carddav twin).
    let type: ReportType;
    if (parsed['calendar-query']) type = 'calendar-query';
    else if (parsed['calendar-multiget']) type = 'calendar-multiget';
    else if (parsed['sync-collection']) type = 'sync-collection';
    else throw new Error('Unsupported REPORT type');

    const root = parsed[type];
    // Whether the client asked for the resource body, decided once here (the carddav twin's readProps) so the
    // three handlers can't read one request differently.
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
