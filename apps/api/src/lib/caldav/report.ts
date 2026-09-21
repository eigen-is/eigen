import { ICS_CONTENT_TYPE } from '@workspace/lib/types/drive';
import type { Calendar } from '../calendar/calendar';
import type { ResourceRow } from '../calendar/calendar-store';
import type { CalendarCollection } from '../calendar/resource-store';
import { uriKeyOf } from '../core';
import { MULTIGET_HREF_LIMIT, resolveMultigetHrefs } from '../dav/href';
import { type DataBudget, REPORT_DATA_BUDGET_BYTES, resourceDataRow } from '../dav/report-row';
import { formatSyncToken, invalidSyncToken, parseSyncToken } from '../dav/sync-token';
import { multistatusResponse, notFoundRow, removedRow } from '../dav/xml';
import { calendarHref, eventHref } from './discovery';
import { calendarDataProp } from './xml-builder';
import { parseReport, type ReportRequest } from './xml-parser';

// REPORT on /dav/calendars/:ownerId/:calendarId/
export async function handleReport(
    calendar: Calendar,
    calendarId: string,
    collection: CalendarCollection,
    ownerId: string,
    body: string,
): Promise<Response> {
    let report: ReportRequest;
    try {
        report = parseReport(body);
    } catch {
        // Empty body, unparseable XML, or an unknown REPORT root all reject here — never a silent etag dump.
        return new Response('Bad Request: invalid REPORT', { status: 400 });
    }

    const budget = { left: REPORT_DATA_BUDGET_BYTES };
    switch (report.type) {
        case 'calendar-query':
            return handleCalendarQuery(calendar, calendarId, ownerId, report, budget);
        case 'calendar-multiget':
            return handleCalendarMultiget(calendar, calendarId, ownerId, report, budget);
        case 'sync-collection':
            return handleSyncCollection(calendar, calendarId, collection, ownerId, report, budget);
    }
}

async function resourceRow(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    resource: ResourceRow,
    wantsData: boolean,
    budget: DataBudget,
): Promise<string> {
    return resourceDataRow({
        href: eventHref(ownerId, calendarId, resource.uri),
        row: resource,
        contentType: ICS_CONTENT_TYPE,
        wantsData,
        dataElement: '<C:calendar-data/>',
        dataProp: calendarDataProp,
        read: () => calendar.readResource(calendarId, resource),
        budget,
    });
}

async function handleCalendarQuery(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    report: Extract<ReportRequest, { type: 'calendar-query' }>,
    budget: DataBudget,
): Promise<Response> {
    // A filter naming a component Eigen does not store matches nothing; a time-range may over-match, never under-match.
    if (!report.matchesEvents) return multistatusResponse([]);
    const resources = report.timeRange
        ? await calendar.getResourcesInRange(calendarId, report.timeRange.start, report.timeRange.end)
        : await calendar.listResources(calendarId);

    const responses: string[] = [];
    for (const resource of resources) {
        responses.push(await resourceRow(calendar, calendarId, ownerId, resource, report.wantsData, budget));
    }
    return multistatusResponse(responses);
}

async function handleCalendarMultiget(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    report: Extract<ReportRequest, { type: 'calendar-multiget' }>,
    budget: DataBudget,
): Promise<Response> {
    if (report.hrefs.length > MULTIGET_HREF_LIMIT) return new Response('Too many hrefs', { status: 400 });

    // Resources fold by uri key, so two spellings of one name name one resource — as a GET resolves it.
    const resolved = resolveMultigetHrefs(report.hrefs, calendarHref(ownerId, calendarId), uriKeyOf);
    const found = new Map(
        (
            await calendar.getResourcesByUris(
                calendarId,
                resolved.map((r) => r.uri).filter((u) => u !== null),
            )
        ).map((resource) => [uriKeyOf(resource.uri), resource] as const),
    );

    const responses: string[] = [];
    for (const { uri, href } of resolved) {
        const resource = uri ? found.get(uriKeyOf(uri)) : undefined;
        if (!resource) {
            // Missing but in-collection → 404 on the resource href; unresolvable → 404 echoing the original.
            responses.push(notFoundRow(uri ? eventHref(ownerId, calendarId, uri) : href));
            continue;
        }
        responses.push(await resourceRow(calendar, calendarId, ownerId, resource, report.wantsData, budget));
    }
    return multistatusResponse(responses);
}

async function handleSyncCollection(
    calendar: Calendar,
    calendarId: string,
    collection: CalendarCollection,
    ownerId: string,
    report: Extract<ReportRequest, { type: 'sync-collection' }>,
    budget: DataBudget,
): Promise<Response> {
    const responses: string[] = [];

    if (!report.syncToken) {
        // Initial sync — the whole collection as 200 rows.
        for (const resource of await calendar.listResources(calendarId)) {
            responses.push(await resourceRow(calendar, calendarId, ownerId, resource, report.wantsData, budget));
        }
    } else {
        const token = parseSyncToken(report.syncToken);
        if (!token) return invalidSyncToken();
        // A stale generation or a ctag ahead of the collection forces a resync: an empty delta under a lower token stalls the client forever.
        if (token.gen !== collection.syncGen || token.since > collection.ctag) return invalidSyncToken();

        for (const resource of await calendar.getChangedResourcesSince(calendarId, token.since)) {
            responses.push(await resourceRow(calendar, calendarId, ownerId, resource, report.wantsData, budget));
        }
        // One tombstone row per uri: no href may be both a 200 and a 404 in one response (RFC 6578).
        for (const removed of await calendar.getDeletedResourcesSince(calendarId, token.since)) {
            responses.push(removedRow(eventHref(ownerId, calendarId, removed.uri)));
        }
    }

    // RFC 6578: the current token is appended after the responses.
    return multistatusResponse(responses, `<D:sync-token>${formatSyncToken(collection)}</D:sync-token>`);
}
