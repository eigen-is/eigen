import type { CalendarItem } from '@workspace/lib/types/calendar';
import { ICS_CONTENT_TYPE } from '@workspace/lib/types/drive';
import type { Calendar } from '../calendar/calendar';
import type { CalendarEventRow } from '../calendar/types';
import { MULTIGET_HREF_LIMIT, resolveMultigetHrefs } from '../dav/href';
import { invalidSyncToken } from '../dav/sync-token';
import { memberProps, multistatusResponse, notFoundRow, propstatOk, removedRow, response } from '../dav/xml';
import { calendarHref, eventHref } from './discovery';
import { eventsToIcs } from './ical-component';
import { calendarDataProp, formatSyncToken, parseSyncToken } from './xml-builder';
import { parseReport, type ReportRequest } from './xml-parser';

// REPORT on /dav/calendars/:ownerId/:calendarId/
export function handleReport(
    calendar: Calendar,
    calendarId: string,
    calendarItem: CalendarItem,
    ownerId: string,
    body: string,
): Response {
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
            return handleSyncCollection(calendar, calendarId, calendarItem, ownerId, report);
    }
}

function handleCalendarQuery(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    report: Extract<ReportRequest, { type: 'calendar-query' }>,
): Response {
    // Only the time-range filter is applied; other prop-filters are intentionally ignored. A CalDAV client
    // re-filters the returned set, so a superset response is safe (RFC 4791 calendar-query).
    let events: CalendarEventRow[];
    if (report.timeRange) {
        events = calendar.getRawEventsInRange(calendarId, report.timeRange.start, report.timeRange.end);
    } else {
        events = calendar.getRawEvents(calendarId);
    }

    const wantsData = report.propNames.some((p) => p.includes('calendar-data'));
    return multistatusResponse(buildEventResponses(events, ownerId, calendarId, wantsData));
}

function handleCalendarMultiget(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    report: Extract<ReportRequest, { type: 'calendar-multiget' }>,
): Response {
    if (report.hrefs.length > MULTIGET_HREF_LIMIT) return new Response('Too many hrefs', { status: 400 });

    // Event uris are matched exactly: unlike cards they have no charset restriction and no folded key.
    const resolved = resolveMultigetHrefs(report.hrefs, calendarHref(ownerId, calendarId), (uri) => uri);

    const uris = resolved.map((r) => r.uri).filter((u): u is string => u !== null);
    const events = calendar.getEventsByUris(calendarId, uris);
    const wantsData = report.propNames.some((p) => p.includes('calendar-data'));

    // uid→all-events map for grouping exceptions with their master — only the UIDs the client asked for.
    const requestedUids = [...new Set(events.map((e) => e.uid))];
    const relatedEvents = calendar.getRawEventsByUids(calendarId, requestedUids);
    const eventsByUid = new Map<string, CalendarEventRow[]>();
    for (const e of relatedEvents) {
        const group = eventsByUid.get(e.uid) ?? [];
        eventsByUid.set(e.uid, group);
        group.push(e);
    }
    // A master and its exceptions share one uri; a uri present only as an exception yields no standalone row.
    const foundUris = new Set(events.map((e) => e.uri));
    const masterByUri = new Map(events.filter((e) => !e.parentEventId).map((e) => [e.uri, e]));

    const responses: string[] = [];
    for (const { uri, href } of resolved) {
        if (uri && foundUris.has(uri)) {
            const master = masterByUri.get(uri);
            if (!master) continue; // uri exists only as an exception (part of a master .ics) — no own row
            const props = memberProps(master.etag, ICS_CONTENT_TYPE);
            if (wantsData) {
                const group = eventsByUid.get(master.uid) ?? [master];
                props.push(calendarDataProp(eventsToIcs(group)));
            }
            responses.push(response(eventHref(ownerId, calendarId, master.uri), [propstatOk(props)]));
        } else {
            // Missing but in-collection → 404 on the event href; unresolvable → 404 echoing the original href.
            const row = uri ? eventHref(ownerId, calendarId, uri) : href;
            responses.push(notFoundRow(row));
        }
    }

    return multistatusResponse(responses);
}

function handleSyncCollection(
    calendar: Calendar,
    calendarId: string,
    calendarItem: CalendarItem,
    ownerId: string,
    report: Extract<ReportRequest, { type: 'sync-collection' }>,
): Response {
    const currentCtag = calendarItem.ctag;
    const responses: string[] = [];

    if (!report.syncToken) {
        // Initial sync — return all events
        const events = calendar.getRawEvents(calendarId);
        const wantsData = report.propNames.some((p) => p.includes('calendar-data'));
        responses.push(...buildEventResponses(events, ownerId, calendarId, wantsData));
    } else {
        // Incremental sync — read the since-ctag from the token.
        const token = parseSyncToken(report.syncToken);
        if (!token) return invalidSyncToken();
        // A token ahead of the calendar (post-restore/rebuild) can't be honored either: an empty delta plus
        // a LOWER token would stall the client forever, blind to every change until the ctag catches back up.
        if (token.since > currentCtag) return invalidSyncToken();

        // Changed events
        const changed = calendar.getChangedEventsSince(calendarId, token.since);
        for (const event of changed) {
            if (event.parentEventId) continue;
            responses.push(
                response(eventHref(ownerId, calendarId, event.uri), [
                    propstatOk(memberProps(event.etag, ICS_CONTENT_TYPE)),
                ]),
            );
        }

        // Deleted events
        const deleted = calendar.getDeletedEventsSince(calendarId, token.since);
        for (const d of deleted) {
            responses.push(removedRow(eventHref(ownerId, calendarId, d.uri)));
        }
    }

    // Build response with sync-token appended after responses (required by RFC 6578)
    return multistatusResponse(responses, `<D:sync-token>${formatSyncToken(currentCtag)}</D:sync-token>`);
}

function buildEventResponses(
    events: CalendarEventRow[],
    ownerId: string,
    calendarId: string,
    includeData: boolean,
): string[] {
    // Build uid→events map so master events can include their exceptions in the ICS
    const eventsByUid = new Map<string, CalendarEventRow[]>();
    for (const e of events) {
        const group = eventsByUid.get(e.uid) ?? [];
        eventsByUid.set(e.uid, group);
        group.push(e);
    }

    const responses: string[] = [];

    for (const event of events) {
        if (event.parentEventId) continue; // Skip exceptions
        const props = memberProps(event.etag, ICS_CONTENT_TYPE);
        if (includeData) {
            const group = eventsByUid.get(event.uid) ?? [event];
            props.push(calendarDataProp(eventsToIcs(group)));
        }
        responses.push(response(eventHref(ownerId, calendarId, event.uri), [propstatOk(props)]));
    }

    return responses;
}
