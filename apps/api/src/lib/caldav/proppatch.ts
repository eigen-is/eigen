import { XMLParser } from 'fast-xml-parser';
import type { Calendar } from '../calendar/calendar';
import { calendarHref, sanitizeCalendarId } from './discovery';
import { multistatusResponse, propstatOk, response } from './xml-builder';

// removeNSPrefix strips the D:/C:/ICAL: prefixes, so property lookups below stay unprefixed — no fallback needed.
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

// A prop element is either the bare text (fxp coerces purely numeric text to a number) or, when it carried an
// attribute (e.g. xml:lang), an object with the value under '#text'. Return the string form; null when absent.
function textOf(value: unknown): string | null {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (value && typeof value === 'object' && '#text' in value) return String((value as { '#text': unknown })['#text']);
    return null;
}

// displayname + calendar-color as the client set them, read identically by MKCALENDAR and PROPPATCH.
function extractCalendarProps(prop: Record<string, unknown>): { name?: string; color?: string } {
    const out: { name?: string; color?: string } = {};
    // Truthiness, not null-checks: an empty <displayname/> means "not set", never an empty name.
    const name = textOf(prop['displayname']);
    if (name) out.name = name;
    const color = textOf(prop['calendar-color']);
    if (color) out.color = color;
    return out;
}

// MKCALENDAR /dav/calendars/:ownerId/:calendarId/ — creates the calendar at the client-chosen id.
export function handleMkcalendar(calendar: Calendar, ownerId: string, calendarId: string, body: string): Response {
    const id = sanitizeCalendarId(calendarId);
    if (!id) return new Response('Bad Request', { status: 400 });
    // MKCALENDAR on an existing collection is a precondition failure (RFC 5689 / WebDAV MKCOL semantics).
    if (calendar.getCalendarById(id)) return new Response('Method Not Allowed', { status: 405 });

    let props: { name?: string; color?: string } = {};
    if (body?.trim()) {
        try {
            const parsed = parser.parse(body);
            const mkcal = parsed['mkcalendar'] || {};
            const set = mkcal['set'] || {};
            props = extractCalendarProps(set['prop'] || {});
        } catch {
            // Ignore XML parse errors — fall back to defaults (supported-calendar-component-set is ignored).
        }
    }

    calendar.createCalendar({ id, name: props.name ?? id, color: props.color ?? '#4285f4' });
    return new Response(null, { status: 201, headers: { Location: calendarHref(ownerId, id) } });
}

// PROPPATCH /dav/calendars/:ownerId/:calendarId/
export async function handleProppatch(
    calendar: Calendar,
    calendarId: string,
    ownerId: string,
    body: string,
): Promise<Response> {
    const calendarItem = calendar.getCalendarById(calendarId);
    if (!calendarItem) return new Response('Not Found', { status: 404 });

    const updates: { name?: string; color?: string } = {};
    const updatedProps: string[] = [];

    if (body?.trim()) {
        try {
            const parsed = parser.parse(body);
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
        await calendar.updateCalendar(calendarId, updates);
    }

    return multistatusResponse([response(calendarHref(ownerId, calendarId), [propstatOk(updatedProps)])]);
}
