import { ICS_CONTENT_TYPE } from '@workspace/lib/types/drive';
import type { Calendar } from '../calendar/calendar';
import { davDeleteResponse, davPutResponse } from '../dav/write-result';
import { calendarHref } from './discovery';

// The CalDAV resource handlers: a thin adapter over the calendar file store, which owns the preconditions,
// the UID rules, re-stamping and the ceiling. See docs/CALENDAR.md § DAV surface.

// GET /dav/calendars/:ownerId/:calendarId/:uri — the stored bytes verbatim (the file IS the resource), with
// the content hash as a quoted ETag. A uri the index doesn't know is a 404.
export async function handleGet(calendar: Calendar, calendarId: string, uri: string): Promise<Response> {
    const resource = await calendar.getResource(calendarId, uri);
    if (!resource) return new Response('Not Found', { status: 404 });
    // Copy into an ArrayBuffer-backed view: storage.bytes() is Uint8Array<ArrayBufferLike>, which the
    // Response BodyInit type rejects (it could be SharedArrayBuffer-backed).
    return new Response(new Uint8Array(resource.bytes), {
        status: 200,
        headers: { 'Content-Type': ICS_CONTENT_TYPE, ETag: `"${resource.etag}"` },
    });
}

// PUT /dav/calendars/:ownerId/:calendarId/:uri — everything happens inside putResource's gate.
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
