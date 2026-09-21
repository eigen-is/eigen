import { ICS_CONTENT_TYPE } from '@workspace/lib/types/drive';
import type { Calendar } from '../calendar/calendar';
import type { ResourceRow } from '../calendar/calendar-store';
import type { CalendarCollection } from '../calendar/resource-store';
import { MULTIGET_HREF_LIMIT, resolveMultigetHrefs } from '../dav/href';
import { formatSyncToken, invalidSyncToken, parseSyncToken } from '../dav/sync-token';
import { memberProps, multistatusResponse, notFoundRow, propstatOk, removedRow, response } from '../dav/xml';
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

    switch (report.type) {
        case 'calendar-query':
            return handleCalendarQuery(calendar, calendarId, ownerId, report);
        case 'calendar-multiget':
            return handleCalendarMultiget(calendar, calendarId, ownerId, report);
        case 'sync-collection':
            return handleSyncCollection(calendar, calendarId, collection, ownerId, report);
    }
}

// A row that also serves the resource body quotes the etag of the bytes it read, never the index row's:
// the two must describe one revision. Without calendar-data nothing is read, so the row's etag is what
// there is.
async function resourceRow(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    resource: ResourceRow,
    wantsData: boolean,
): Promise<string> {
    const served = wantsData ? await calendar.getResource(calendarId, resource.uri) : null;
    const props = memberProps(served?.etag ?? resource.etag, ICS_CONTENT_TYPE);
    if (served) props.push(calendarDataProp(new TextDecoder().decode(served.bytes)));
    return response(eventHref(ownerId, calendarId, resource.uri), [propstatOk(props)]);
}

async function handleCalendarQuery(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    report: Extract<ReportRequest, { type: 'calendar-query' }>,
): Promise<Response> {
    // Only the time-range filter is applied; other prop-filters are intentionally ignored. A CalDAV client
    // re-filters the returned set, so a superset response is safe (RFC 4791 calendar-query).
    const resources = report.timeRange
        ? await calendar.getResourcesInRange(calendarId, report.timeRange.start, report.timeRange.end)
        : await calendar.listResources(calendarId);

    const responses: string[] = [];
    for (const resource of resources) {
        responses.push(await resourceRow(calendar, calendarId, ownerId, resource, report.wantsData));
    }
    return multistatusResponse(responses);
}

async function handleCalendarMultiget(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    report: Extract<ReportRequest, { type: 'calendar-multiget' }>,
): Promise<Response> {
    if (report.hrefs.length > MULTIGET_HREF_LIMIT) return new Response('Too many hrefs', { status: 400 });

    const resolved = resolveMultigetHrefs(report.hrefs, calendarHref(ownerId, calendarId), (uri) => uri);
    const found = new Map(
        (
            await calendar.getResourcesByUris(
                calendarId,
                resolved.map((r) => r.uri).filter((u) => u !== null),
            )
        ).map((resource) => [resource.uri, resource] as const),
    );

    const responses: string[] = [];
    for (const { uri, href } of resolved) {
        const resource = uri ? found.get(uri) : undefined;
        if (!resource) {
            // Missing but in-collection → 404 on the resource href; unresolvable → 404 echoing the original.
            responses.push(notFoundRow(uri ? eventHref(ownerId, calendarId, uri) : href));
            continue;
        }
        responses.push(await resourceRow(calendar, calendarId, ownerId, resource, report.wantsData));
    }
    return multistatusResponse(responses);
}

async function handleSyncCollection(
    calendar: Calendar,
    calendarId: string,
    collection: CalendarCollection,
    ownerId: string,
    report: Extract<ReportRequest, { type: 'sync-collection' }>,
): Promise<Response> {
    const responses: string[] = [];

    if (!report.syncToken) {
        // Initial sync — the whole collection as 200 rows.
        for (const resource of await calendar.listResources(calendarId)) {
            responses.push(await resourceRow(calendar, calendarId, ownerId, resource, report.wantsData));
        }
    } else {
        const token = parseSyncToken(report.syncToken);
        if (!token) return invalidSyncToken();
        // A stale generation (index rebuilt → syncGen rotated) OR a ctag ahead of the collection both force
        // a clean full resync — answering a post-restore future token with an empty delta and a LOWER token
        // would stall that client permanently, blind to every change until the ctag caught back up.
        if (token.gen !== collection.syncGen || token.since > collection.ctag) return invalidSyncToken();

        for (const resource of await calendar.getChangedResourcesSince(calendarId, token.since)) {
            responses.push(await resourceRow(calendar, calendarId, ownerId, resource, report.wantsData));
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
