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

// Discriminated union, the CardDAV twin's shape (carddav xml-parser.ts): each report type carries only the
// fields it uses, so a handler taking Extract<ReportRequest, {type}> can't read a field meant for another.
export type ReportRequest =
    | { type: 'calendar-query'; timeRange?: { start: Date; end: Date }; propNames: string[] }
    | { type: 'calendar-multiget'; hrefs: string[]; propNames: string[] }
    | { type: 'sync-collection'; syncToken?: string; propNames: string[] };

export function parseReport(xml: string): ReportRequest {
    const parsed = parser.parse(xml);

    // removeNSPrefix strips the D:/C: prefixes, so a report's root is always unprefixed — no fallback needed.
    // An empty body or an unknown root matches nothing and throws: a bodyless or unknown REPORT must 400,
    // never default to a calendar-query that dumps every event's etag (the report.ts contract, carddav twin).
    let type: ReportType;
    if (parsed['calendar-query']) type = 'calendar-query';
    else if (parsed['calendar-multiget']) type = 'calendar-multiget';
    else if (parsed['sync-collection']) type = 'sync-collection';
    else throw new Error('Unsupported REPORT type');

    const root = parsed[type];
    const propNames = Object.keys(root['prop'] || {});

    if (type === 'calendar-multiget') {
        const hrefData = root['href'] || [];
        const hrefs = Array.isArray(hrefData) ? hrefData.map(String) : [String(hrefData)].filter(Boolean);
        return { type, hrefs, propNames };
    }

    if (type === 'sync-collection') {
        const syncToken = root['sync-token'] || undefined;
        return { type, syncToken: syncToken ? String(syncToken) : undefined, propNames };
    }

    // calendar-query: only the VEVENT time-range filter is read.
    const veventFilter = root['filter']?.['comp-filter']?.['comp-filter'] || {};
    const timeRange = veventFilter['time-range'];
    let parsedTimeRange: { start: Date; end: Date } | undefined;
    if (timeRange) {
        const start = timeRange['@_start'] ? parseCalDavDate(timeRange['@_start']) : undefined;
        const end = timeRange['@_end'] ? parseCalDavDate(timeRange['@_end']) : undefined;
        // Only honour a fully-valid range; a malformed bound drops the range (→ full listing) rather
        // than feeding Invalid Date into rrule.between.
        if (start && end) parsedTimeRange = { start, end };
    }
    return { type, timeRange: parsedTimeRange, propNames };
}
