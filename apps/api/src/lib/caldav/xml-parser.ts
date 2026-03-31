import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    isArray: (name) => ['href', 'comp'].includes(name),
});

export type ReportType = 'calendar-query' | 'calendar-multiget' | 'sync-collection';

export type ReportRequest = {
    type: ReportType;
    hrefs: string[];
    timeRange?: { start: number; end: number };
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

    let parsedTimeRange: { start: number; end: number } | undefined;
    if (timeRange) {
        const start = timeRange['@_start'];
        const end = timeRange['@_end'];
        if (start && end) {
            parsedTimeRange = {
                start: Math.floor(new Date(start).getTime() / 1000),
                end: Math.floor(new Date(end).getTime() / 1000),
            };
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
