import type { Calendar } from '../calendar/calendar';
import { sanitizeCalendarId } from '../calendar/resource-store';
import { ApiError } from '../core';
import { multistatusResponse, propstatOk, response } from '../dav/xml';
import { isXmlNode, type XmlNode } from '../dav/xml-node';
import { calendarHref } from './discovery';
import { caldavXmlParser } from './xml-parser';

// A prop that carried an attribute (xml:lang) parses to an object holding the value under '#text', not a bare string.
function textOf(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (isXmlNode(value) && '#text' in value) return String(value['#text']);
    return null;
}

// displayname + calendar-color as the client set them, read identically by MKCALENDAR and PROPPATCH.
function extractCalendarProps(prop: XmlNode): { name?: string; color?: string } {
    const out: { name?: string; color?: string } = {};
    // Truthiness, not null-checks: an empty <displayname/> means "not set", never an empty name.
    const name = textOf(prop['displayname']);
    if (name) out.name = name;
    const color = textOf(prop['calendar-color']);
    if (color) out.color = color;
    return out;
}

// MKCALENDAR /dav/calendars/:ownerId/:calendarId/ — creates the calendar at the client-chosen id.
export async function handleMkcalendar(
    calendar: Calendar,
    ownerId: string,
    calendarId: string,
    body: string,
): Promise<Response> {
    const id = sanitizeCalendarId(calendarId);
    if (!id) return new Response('Bad Request', { status: 400 });

    let props: { name?: string; color?: string } = {};
    if (body?.trim()) {
        try {
            const parsed = caldavXmlParser.parse(body);
            const mkcal = parsed['mkcalendar'] || {};
            const set = mkcal['set'] || {};
            props = extractCalendarProps(set['prop'] || {});
        } catch {
            // Ignore XML parse errors — fall back to defaults (supported-calendar-component-set is ignored).
        }
    }

    try {
        await calendar.createCalendar({ id, name: props.name ?? id, color: props.color });
    } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // One directory is one calendar, so a case variant of an existing name hits the same collection: 405 (RFC 5689).
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
    body: string,
): Promise<Response> {
    const calendarItem = await calendar.getCalendarById(calendarId);
    if (!calendarItem) return new Response('Not Found', { status: 404 });

    const updates: { name?: string; color?: string } = {};
    const updatedProps: string[] = [];

    if (body?.trim()) {
        try {
            const parsed = caldavXmlParser.parse(body);
            const propertyupdate = parsed['propertyupdate'] || {};
            const set = propertyupdate['set'] || {};
            const props = extractCalendarProps(set['prop'] || {});

            if (props.name !== undefined) {
                updates.name = props.name;
                updatedProps.push('<D:displayname/>');
            }
            if (props.color !== undefined) {
                updates.color = props.color;
                updatedProps.push('<ICAL:calendar-color/>');
            }
        } catch {
            return new Response('Bad Request', { status: 400 });
        }
    }

    if (Object.keys(updates).length > 0) {
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
