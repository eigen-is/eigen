import { XMLParser } from 'fast-xml-parser';
import ICAL from 'ical.js';

// CalDAV <C:time-range> bounds are RFC 5545 BASIC format (YYYYMMDD or YYYYMMDDTHHMMSS[Z]). `new Date()`
// only reads EXTENDED ISO and returns Invalid Date on basic input, which then flows into
// rrule.between(Invalid, Invalid) and silently empties (or crashes) the REPORT. Normalise basic →
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

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    // Keep element text as text — fxp's default numeric coercion mangles digit-only values (the carddav
    // twin's <text-match> phone bug); nothing here is meant to be numeric.
    parseTagValue: false,
    isArray: (name) => ['href', 'comp'].includes(name),
});

export type ReportType = 'calendar-query' | 'calendar-multiget' | 'sync-collection';

export type ReportRequest = {
    type: ReportType;
    hrefs: string[];
    timeRange?: { start: Date; end: Date };
    syncToken?: string;
    propNames: string[];
};

export function parseReport(xml: string): ReportRequest {
    if (!xml?.trim()) return { type: 'calendar-query', hrefs: [], propNames: [] };
    const parsed = parser.parse(xml);

    // Detect report type from root element
    const root =
        parsed['calendar-query'] ||
        parsed['C:calendar-query'] ||
        parsed['calendar-multiget'] ||
        parsed['C:calendar-multiget'] ||
        parsed['sync-collection'] ||
        parsed['D:sync-collection'] ||
        {};

    let type: ReportType = 'calendar-query';
    if (parsed['calendar-multiget'] || parsed['C:calendar-multiget']) type = 'calendar-multiget';
    if (parsed['sync-collection'] || parsed['D:sync-collection']) type = 'sync-collection';

    // Extract hrefs (for multiget)
    const hrefData = root['href'] || root['D:href'] || [];
    const hrefs = Array.isArray(hrefData) ? hrefData.map(String) : [String(hrefData)].filter(Boolean);

    // Extract time-range (for calendar-query)
    const filter = root['filter'] || root['C:filter'] || {};
    const compFilter = filter['comp-filter'] || filter['C:comp-filter'] || {};
    const veventFilter = compFilter['comp-filter'] || compFilter['C:comp-filter'] || {};
    const timeRange = veventFilter['time-range'] || veventFilter['C:time-range'];

    let parsedTimeRange: { start: Date; end: Date } | undefined;
    if (timeRange) {
        const start = timeRange['@_start'] ? parseCalDavDate(timeRange['@_start']) : undefined;
        const end = timeRange['@_end'] ? parseCalDavDate(timeRange['@_end']) : undefined;
        // Only honour a fully-valid range; a malformed bound drops the range (→ full listing) rather
        // than feeding Invalid Date into rrule.between.
        if (start && end) {
            parsedTimeRange = { start, end };
        }
    }

    // Extract sync-token
    const syncToken = root['sync-token'] || root['D:sync-token'] || undefined;

    // Extract requested props
    const prop = root['prop'] || root['D:prop'] || {};
    const propNames = Object.keys(prop);

    return {
        type,
        hrefs,
        timeRange: parsedTimeRange,
        syncToken: syncToken ? String(syncToken) : undefined,
        propNames,
    };
}
