import { ICS_CONTENT_TYPE } from '@workspace/lib/types/drive';
import type { Calendar } from '../calendar/calendar';
import type { ResourceRow } from '../calendar/calendar-store';
import type { CalendarCollection } from '../calendar/resource-store';
import { uriKeyOf } from '../core';
import { MULTIGET_HREF_LIMIT, resolveMultigetHrefs } from '../dav/href';
import { formatSyncToken, invalidSyncToken, parseSyncToken } from '../dav/sync-token';
import {
    memberProps,
    multistatusResponse,
    notFoundRow,
    propstatNotFound,
    propstatOk,
    removedRow,
    response,
} from '../dav/xml';
import { calendarHref, eventHref } from './discovery';
import { calendarDataProp } from './xml-builder';
import { parseReport, type ReportRequest } from './xml-parser';

// How many bytes of calendar data one REPORT serves. Past it a row still appears, with its etag and a 404
// for the data the client then multigets (RFC 4918 § 9.1): a truncated collection loses events silently.
export const REPORT_DATA_BUDGET_BYTES = 33_554_432;

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

// What one REPORT may still spend on resource bodies.
type DataBudget = { left: number };

// A row that serves the body quotes the etag of the bytes it read, never the index row's: the two must
// describe one revision.
async function resourceRow(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    resource: ResourceRow,
    wantsData: boolean,
    budget: DataBudget,
): Promise<string> {
    const href = eventHref(ownerId, calendarId, resource.uri);
    if (!wantsData) return response(href, [propstatOk(memberProps(resource.etag, ICS_CONTENT_TYPE))]);
    if (resource.size > budget.left) {
        return response(href, [
            propstatOk(memberProps(resource.etag, ICS_CONTENT_TYPE)),
            propstatNotFound(['<C:calendar-data/>']),
        ]);
    }

    const served = await calendar.getResource(calendarId, resource.uri);
    // The row is there and the file is not: the drain tombstones it, and this response says it is gone.
    if (!served) return notFoundRow(href);
    budget.left -= served.bytes.length;
    const props = memberProps(served.etag, ICS_CONTENT_TYPE);
    props.push(calendarDataProp(new TextDecoder().decode(served.bytes)));
    return response(href, [propstatOk(props)]);
}

async function handleCalendarQuery(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    report: Extract<ReportRequest, { type: 'calendar-query' }>,
    budget: DataBudget,
): Promise<Response> {
    // A filter naming a component Eigen does not store matches nothing. The one superset served here is
    // the time-range's: a resource whose recurrence the index cannot expand rides along (R16 5b).
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
        // A stale generation or a ctag ahead of the collection both force a clean resync: an empty delta
        // under a LOWER token would stall that client permanently.
        if (token.gen !== collection.syncGen || token.since > collection.ctag) return invalidSyncToken();

        for (const resource of await calendar.getChangedResourcesSince(calendarId, token.since)) {
            responses.push(await resourceRow(calendar, calendarId, ownerId, resource, report.wantsData, budget));
        }
        // One tombstone row per uri: the tombstone primary key and the commit's tombstone-clear together
        // guarantee no href is both a 200 and a 404 in one response (RFC 6578).
        for (const removed of await calendar.getDeletedResourcesSince(calendarId, token.since)) {
            responses.push(removedRow(eventHref(ownerId, calendarId, removed.uri)));
        }
    }

    // RFC 6578: the current token is appended after the responses.
    return multistatusResponse(responses, `<D:sync-token>${formatSyncToken(collection)}</D:sync-token>`);
}
