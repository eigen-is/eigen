import { ICS_CONTENT_TYPE } from '@workspace/lib/types/drive';
import type { Calendar } from '../calendar/calendar';
import type { ResourceRow } from '../calendar/dav-store';
import type { CalendarCollection } from '../calendar/resource-store';
import { normalizeResourceUri } from '../core';
import { MULTIGET_HREF_LIMIT, resolveMultigetHrefs } from '../dav/href';
import { type DataBudget, multigetRows, REPORT_DATA_BUDGET_BYTES, resourceDataRow } from '../dav/report-row';
import { handleSyncCollection } from '../dav/sync-collection';
import { multistatusResponse, notFoundRow } from '../dav/xml';
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
            return handleSyncCollection(report.syncToken, {
                state: collection,
                list: () => calendar.listResources(calendarId),
                changedSince: (ctag) => calendar.getChangedResourcesSince(calendarId, ctag),
                deletedSince: (ctag) => calendar.getDeletedResourcesSince(calendarId, ctag),
                href: (uri) => eventHref(ownerId, calendarId, uri),
                row: (resource, vanished) =>
                    resourceRow(calendar, calendarId, ownerId, resource, report.wantsData, budget, vanished),
            });
    }
}

async function resourceRow(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    resource: ResourceRow,
    wantsData: boolean,
    budget: DataBudget,
    vanished: (href: string) => string = notFoundRow,
): Promise<string> {
    return resourceDataRow({
        href: eventHref(ownerId, calendarId, resource.uri),
        row: resource,
        contentType: ICS_CONTENT_TYPE,
        wantsData,
        dataElement: '<C:calendar-data/>',
        dataProp: calendarDataProp,
        read: () => calendar.getResource(calendarId, resource.uri),
        vanished,
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
    const resources = (
        report.timeRange
            ? await calendar.getResourcesInRange(calendarId, report.timeRange.start, report.timeRange.end)
            : await calendar.listResources(calendarId)
    ).filter((resource) => report.matchesUid(resource.uid));

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

    // Only the Unicode form is folded, so an NFD href and its NFC twin yield one row (the shared resolver's `keyOf`).
    const resolved = resolveMultigetHrefs(report.hrefs, calendarHref(ownerId, calendarId), normalizeResourceUri);
    const found = new Map(
        (
            await calendar.getResourcesByUris(
                calendarId,
                resolved.map((r) => r.uri).filter((u) => u !== null),
            )
        ).map((resource) => [normalizeResourceUri(resource.uri), resource] as const),
    );

    return multistatusResponse(
        await multigetRows(
            resolved,
            async (uri) => found.get(normalizeResourceUri(uri)) ?? null,
            (uri) => eventHref(ownerId, calendarId, uri),
            (resource) => resourceRow(calendar, calendarId, ownerId, resource, report.wantsData, budget),
        ),
    );
}
