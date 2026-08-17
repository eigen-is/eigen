import { XMLParser } from 'fast-xml-parser';
import type { Calendar } from '../calendar/calendar';
import { multistatus, propstatOk, response, XML_CONTENT_TYPE } from './xml-builder';

// removeNSPrefix strips the D:/C:/ICAL: prefixes, so property lookups below stay unprefixed — no fallback needed.
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

// MKCALENDAR /dav/calendars/:ownerId/:calendarId/
export function handleMkcalendar(calendar: Calendar, body: string): Response {
    let name = 'New Calendar';
    let color = '#4285f4';

    if (body?.trim()) {
        try {
            const parsed = parser.parse(body);
            const mkcal = parsed['mkcalendar'] || {};
            const set = mkcal['set'] || {};
            const prop = set['prop'] || {};

            const displayName = prop['displayname'];
            if (displayName && typeof displayName === 'string') name = displayName;

            const calColor = prop['calendar-color'];
            if (calColor && typeof calColor === 'string') color = calColor;
        } catch {
            // Ignore XML parse errors — use defaults
        }
    }

    calendar.createCalendar({ name, color });
    return new Response(null, { status: 201 });
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
            const prop = set['prop'] || {};

            const displayName = prop['displayname'];
            if (displayName && typeof displayName === 'string') {
                updates.name = displayName;
                updatedProps.push('<D:displayname/>');
            }

            const calColorRaw = prop['calendar-color'];
            const calColor =
                typeof calColorRaw === 'string'
                    ? calColorRaw
                    : calColorRaw && typeof calColorRaw === 'object' && '#text' in calColorRaw
                      ? String(calColorRaw['#text'])
                      : null;
            if (calColor) {
                updates.color = calColor;
                updatedProps.push('<ICAL:calendar-color/>');
            }
        } catch {
            return new Response('Bad Request', { status: 400 });
        }
    }

    if (Object.keys(updates).length > 0) {
        await calendar.updateCalendar(calendarId, updates);
    }

    const xml = multistatus([response(`/dav/calendars/${ownerId}/${calendarId}/`, [propstatOk(updatedProps)])]);
    return new Response(xml, { status: 207, headers: { 'Content-Type': XML_CONTENT_TYPE } });
}
