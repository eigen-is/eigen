import type { CalendarItem } from '@workspace/lib/types/calendar';
import type { Calendar, CalendarEventRow } from '../calendar/calendar';
import { eventsToIcs } from './ical-serialize';
import { calendarDataProp, eventEtagProp, multistatus, propstatNotFound, propstatOk, response } from './xml-builder';
import { parseReport, type ReportRequest } from './xml-parser';

const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';

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
        return new Response('Bad Request: invalid XML', { status: 400 });
    }

    switch (report.type) {
        case 'calendar-query':
            return handleCalendarQuery(calendar, calendarId, ownerId, report);
        case 'calendar-multiget':
            return handleCalendarMultiget(calendar, calendarId, ownerId, report);
        case 'sync-collection':
            return handleSyncCollection(calendar, calendarId, calendarItem, ownerId, report);
        default:
            return new Response('Unsupported report type', { status: 400 });
    }
}

function handleCalendarQuery(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    report: ReturnType<typeof parseReport>,
): Response {
    let events: CalendarEventRow[];
    if (report.timeRange) {
        events = calendar.getRawEventsInRange(calendarId, report.timeRange.start, report.timeRange.end);
    } else {
        events = calendar.getRawEvents(calendarId);
    }

    const wantsData = report.propNames.some((p) => p.includes('calendar-data'));
    const responses = buildEventResponses(events, ownerId, calendarId, wantsData);
    return new Response(multistatus(responses), {
        status: 207,
        headers: { 'Content-Type': XML_CONTENT_TYPE },
    });
}

function handleCalendarMultiget(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    report: ReturnType<typeof parseReport>,
): Response {
    const prefix = `/dav/calendars/${ownerId}/${calendarId}/`;
    const uris = report.hrefs
        .map((href) => {
            const h = href.replace(/^\/+/, '/');
            return h.startsWith(prefix) ? h.slice(prefix.length) : '';
        })
        .filter(Boolean);

    const events = calendar.getEventsByUris(calendarId, uris);
    const wantsData = report.propNames.some((p) => p.includes('calendar-data'));

    // Build a uid→all-events map for grouping exceptions with their master
    const allEvents = calendar.getRawEvents(calendarId);
    const eventsByUid = new Map<string, CalendarEventRow[]>();
    for (const e of allEvents) {
        const group = eventsByUid.get(e.uid) ?? [];
        eventsByUid.set(e.uid, group);
        group.push(e);
    }

    const responses: string[] = [];

    for (const event of events) {
        if (event.parentEventId) continue; // Skip exceptions (part of master .ics)
        const href = `${prefix}${event.uri}`;
        const props = [...eventEtagProp(event.etag)];
        if (wantsData) {
            const group = eventsByUid.get(event.uid) ?? [event];
            props.push(calendarDataProp(eventsToIcs(group)));
        }
        responses.push(response(href, [propstatOk(props)]));
    }

    // Include 404 for missing URIs
    const foundUris = new Set(events.map((e) => e.uri));
    for (const uri of uris) {
        if (!foundUris.has(uri)) {
            responses.push(response(`${prefix}${uri}`, [propstatNotFound([`<D:getetag/>`])]));
        }
    }

    return new Response(multistatus(responses), {
        status: 207,
        headers: { 'Content-Type': XML_CONTENT_TYPE },
    });
}

function handleSyncCollection(
    calendar: Calendar,
    calendarId: string,
    calendarItem: CalendarItem,
    ownerId: string,
    report: ReturnType<typeof parseReport>,
): Response {
    const prefix = `/dav/calendars/${ownerId}/${calendarId}/`;
    const currentCtag = calendarItem.ctag;
    const responses: string[] = [];

    if (!report.syncToken) {
        // Initial sync — return all events
        const events = calendar.getRawEvents(calendarId);
        const wantsData = report.propNames.some((p) => p.includes('calendar-data'));
        responses.push(...buildEventResponses(events, ownerId, calendarId, wantsData));
    } else {
        // Incremental sync — parse ctag from token
        const tokenMatch = report.syncToken.match(/\/sync\/(\d+)$/);
        if (!tokenMatch) {
            // Invalid sync token — client must do full resync
            return new Response(
                `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:"><D:valid-sync-token/></D:error>`,
                { status: 403, headers: { 'Content-Type': XML_CONTENT_TYPE } },
            );
        }

        const sinceCtag = parseInt(tokenMatch[1], 10);

        // Changed events
        const changed = calendar.getChangedEventsSince(calendarId, sinceCtag);
        for (const event of changed) {
            if (event.parentEventId) continue;
            const href = `${prefix}${event.uri}`;
            responses.push(response(href, [propstatOk(eventEtagProp(event.etag))]));
        }

        // Deleted events
        const deleted = calendar.getDeletedEventsSince(calendarId, sinceCtag);
        for (const d of deleted) {
            responses.push(
                `<D:response><D:href>${prefix}${d.uri}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
            );
        }
    }

    // Build response with sync-token
    const syncToken = `https://eigen.is/ns/sync/${currentCtag}`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:ICAL="http://apple.com/ns/ical/">${responses.join('')}<D:sync-token>${syncToken}</D:sync-token></D:multistatus>`;

    return new Response(xml, {
        status: 207,
        headers: { 'Content-Type': XML_CONTENT_TYPE },
    });
}

function buildEventResponses(
    events: CalendarEventRow[],
    ownerId: string,
    calendarId: string,
    includeData: boolean,
): string[] {
    const prefix = `/dav/calendars/${ownerId}/${calendarId}/`;

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
        const href = `${prefix}${event.uri}`;
        const props = [...eventEtagProp(event.etag)];
        if (includeData) {
            const group = eventsByUid.get(event.uid) ?? [event];
            props.push(calendarDataProp(eventsToIcs(group)));
        }
        responses.push(response(href, [propstatOk(props)]));
    }

    return responses;
}
