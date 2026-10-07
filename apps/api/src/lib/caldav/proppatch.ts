import type { Calendar } from '../calendar/calendar';
import { sanitizeCalendarId } from '../calendar/resource-store';
import { ApiError, parseXmlRoot, type XmlElement, xmlChild, xmlChildren, xmlTrimmedText } from '../core';
import { DAV_NAMESPACES, multistatusResponse, propstatOk, response } from '../dav/xml';
import { calendarHref } from './discovery';

const DAV = DAV_NAMESPACES.D;

// displayname + calendar-color as the client set them, read identically by MKCALENDAR and PROPPATCH: every
// <set> in order, so a later one wins. supported-calendar-component-set and the rest are ignored.
function extractCalendarProps(update: XmlElement | null): { name?: string; color?: string } {
    const out: { name?: string; color?: string } = {};
    if (!update) return out;
    for (const prop of xmlChildren(update, DAV, 'set').flatMap((set) => xmlChildren(set, DAV, 'prop'))) {
        // Truthiness, not null-checks: an empty <displayname/> means "not set", never an empty name.
        const name = xmlTrimmedText(xmlChild(prop, DAV, 'displayname'));
        if (name) out.name = name;
        const color = xmlTrimmedText(xmlChild(prop, DAV_NAMESPACES.ICAL, 'calendar-color'));
        if (color) out.color = color;
    }
    return out;
}

// MKCALENDAR /dav/calendars/:ownerId/:calendarId/ — creates the calendar at the client-chosen id.
export async function handleMkcalendar(
    calendar: Calendar,
    ownerId: string,
    calendarId: string,
    body: Uint8Array,
): Promise<Response> {
    const id = sanitizeCalendarId(calendarId);
    if (!id) return new Response('Bad Request', { status: 400 });

    const props = extractCalendarProps(parseXmlRoot(body, DAV_NAMESPACES.C, 'mkcalendar'));

    try {
        await calendar.createCalendar({ id, name: props.name ?? id, color: props.color });
    } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // The id is taken as written, so the collection MKCALENDAR asks for already exists: 405 (RFC 5689).
        if (error.status === 409) return new Response('Method Not Allowed', { status: 405 });
        // A property value the domain refuses is WebDAV's 403 on a property the server will not set.
        if (error.status === 400) return new Response('Forbidden', { status: 403 });
        throw error;
    }
    return new Response(null, { status: 201, headers: { Location: calendarHref(ownerId, id) } });
}

// DAV renames one status deleteCalendar raises: the default calendar's 400 refusal is WebDAV's 403 on a protected collection.
export async function handleDeleteCalendar(calendar: Calendar, calendarId: string): Promise<Response> {
    try {
        await calendar.deleteCalendar(calendarId);
    } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.status === 404) return new Response('Not Found', { status: 404 });
        if (error.status === 400) return new Response('Forbidden', { status: 403 });
        throw error;
    }
    return new Response(null, { status: 204 });
}

// PROPPATCH /dav/calendars/:ownerId/:calendarId/
export async function handleProppatch(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    body: Uint8Array,
): Promise<Response> {
    const calendarItem = await calendar.getCalendarById(calendarId);
    if (!calendarItem) return new Response('Not Found', { status: 404 });

    const updates = extractCalendarProps(parseXmlRoot(body, DAV, 'propertyupdate'));
    const updatedProps: string[] = [];
    if (updates.name !== undefined) updatedProps.push('<D:displayname/>');
    if (updates.color !== undefined) updatedProps.push('<ICAL:calendar-color/>');

    if (updatedProps.length > 0) {
        try {
            await calendar.updateCalendar(calendarId, updates);
        } catch (error) {
            // A property value the domain refuses is WebDAV's 403 on a property the server will not set.
            if (error instanceof ApiError && error.status === 400) {
                return new Response('Forbidden', { status: 403 });
            }
            throw error;
        }
    }

    return multistatusResponse([response(calendarHref(ownerId, calendarId), [propstatOk(updatedProps)])]);
}
