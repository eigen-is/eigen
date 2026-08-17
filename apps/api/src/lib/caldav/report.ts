import type { CalendarItem } from '@workspace/lib/types/calendar';
import type { Calendar } from '../calendar/calendar';
import type { CalendarEventRow } from '../calendar/types';
import { eventsToIcs } from './ical-serialize';
import {
    calendarDataProp,
    davError,
    eventEtagProp,
    multistatusResponse,
    propstatNotFound,
    propstatOk,
    response,
} from './xml-builder';
import { parseReport, type ReportRequest } from './xml-parser';

// Request bounds, the CardDAV twin's values (carddav/report.ts): the router rejects any XML request body
// (REPORT/MKCALENDAR/PROPPATCH) over this before it reaches the parser, and multiget refuses a client that
// asks for more than this many resources in one round-trip.
export const REPORT_BODY_MAX_BYTES = 1_048_576;
const MULTIGET_HREF_LIMIT = 500;

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
    return multistatusResponse(buildEventResponses(events, ownerId, calendarId, wantsData));
}

function handleCalendarMultiget(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    report: ReturnType<typeof parseReport>,
): Response {
    if (report.hrefs.length > MULTIGET_HREF_LIMIT) return new Response('Too many hrefs', { status: 400 });

    const prefix = `/dav/calendars/${ownerId}/${calendarId}/`;
    // Dedupe so a client listing one resource N ways yields one row, not N — the 404 loop below iterates this
    // set, closing the duplicate-404-rows nit; first occurrence wins, preserving request order.
    const uris = [
        ...new Set(
            report.hrefs
                .map((href) => {
                    const h = href.replace(/^\/+/, '/');
                    return h.startsWith(prefix) ? h.slice(prefix.length) : '';
                })
                .filter(Boolean),
        ),
    ];

    const events = calendar.getEventsByUris(calendarId, uris);
    const wantsData = report.propNames.some((p) => p.includes('calendar-data'));

    // Build a uid→all-events map for grouping exceptions with their master — only for the UIDs the
    // client actually asked for, not the whole collection.
    const requestedUids = [...new Set(events.map((e) => e.uid))];
    const relatedEvents = calendar.getRawEventsByUids(calendarId, requestedUids);
    const eventsByUid = new Map<string, CalendarEventRow[]>();
    for (const e of relatedEvents) {
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

    return multistatusResponse(responses);
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
        // Accept both old `/sync/N` and new `:sync:N` separators so clients with stored
        // pre-rename tokens don't need a forced full resync.
        const tokenMatch = report.syncToken.match(/sync[/:](\d+)$/);
        if (!tokenMatch) {
            // Invalid sync token — client must do full resync
            return davError(403, '<D:valid-sync-token/>');
        }

        const sinceCtag = parseInt(tokenMatch[1], 10);
        // A token ahead of the calendar (post-restore/rebuild) can't be honoured either: an empty delta plus
        // a LOWER token would stall the client forever, blind to every change until the ctag catches back up
        // (the guard the carddav twin shipped with).
        if (sinceCtag > currentCtag) {
            return davError(403, '<D:valid-sync-token/>');
        }

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
            responses.push(response(`${prefix}${d.uri}`, [`<D:status>HTTP/1.1 404 Not Found</D:status>`]));
        }
    }

    // Build response with sync-token appended after responses (required by RFC 6578)
    return multistatusResponse(responses, `<D:sync-token>urn:eigen:sync:${currentCtag}</D:sync-token>`);
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
