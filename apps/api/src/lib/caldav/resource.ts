import { ICS_CONTENT_TYPE } from '@workspace/lib/types/drive';
import type { Calendar } from '../calendar/calendar';
import { davDeleteResponse, davPutResponse, davResourceResponse } from '../dav/write-result';
import { calendarHref } from './discovery';

// A thin adapter: the calendar store owns the preconditions, the UID rules and the ceiling (docs/CALENDAR.md § CalDAV surface).

// GET /dav/calendars/:ownerId/:calendarId/:uri — the stored bytes ARE the resource. A uri no row holds is a 404.
export async function handleGet(calendar: Calendar, calendarId: string, uri: string): Promise<Response> {
    const resource = await calendar.getResource(calendarId, uri);
    if (!resource) return new Response('Not Found', { status: 404 });
    return davResourceResponse(resource.bytes, resource.etag, ICS_CONTENT_TYPE);
}

// PUT /dav/calendars/:ownerId/:calendarId/:uri — everything happens inside putResource's write lock.
export async function handlePut(
    calendar: Calendar,
    ownerId: string,
    calendarId: string,
    uri: string,
    body: string,
    ifMatch: string | null,
    ifNoneMatch: string | null,
    userId: string,
): Promise<Response> {
    const result = await calendar.putResource(calendarId, uri, body, { ifMatch, ifNoneMatch, actor: userId });
    return davPutResponse(result, 'C', calendarHref(ownerId, calendarId), uri);
}

// DELETE /dav/calendars/:ownerId/:calendarId/:uri — an unknown uri is a 404, deliberately unlike REST.
export async function handleDelete(
    calendar: Calendar,
    calendarId: string,
    uri: string,
    ifMatch: string | null,
): Promise<Response> {
    return davDeleteResponse(await calendar.deleteResource(calendarId, uri, { ifMatch }));
}
