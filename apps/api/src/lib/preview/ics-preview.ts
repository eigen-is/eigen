// The payload of a `.ics` quick look: the events one file holds, bounded for a card, and a count of what could not be
// read. The preview job builds it from the file's bytes with the parser every calendar file goes through, and the
// preview route serves the cached result.

import type { IcsPreview, IcsPreviewEvent } from '@workspace/lib/types/preview';
import { validateEmailAddress } from '@workspace/lib/validation';
import { ApiError } from '../core/errors';
import { countVEvents, decodeUtf8Strict, ICS_IMPORT_MAX_EVENTS } from '../core/transfer';
import { parseIcs } from '../ical';
import type { IcsParseResult, ParsedEvent } from '../ical/ical-parse';

// A calendar export is a year of a team's meetings and an event's description is a whole agenda.
export const ICS_PREVIEW_MAX_EVENTS = 200;
export const ICS_PREVIEW_MAX_DESCRIPTION_CHARS = 10_000;
export const ICS_PREVIEW_MAX_ATTENDEES = 100;

export const parseIcsPreview = (body: string): IcsPreview => JSON.parse(body);

// An all-day event is stored as UTC midnight with an exclusive end, which is the pair the card reads back.
const dateString = (date: Date, allDay: boolean): string =>
    allDay ? date.toISOString().slice(0, 10) : date.toISOString();

// toISOString spells a year outside 1–9999 with a sign and six digits, and a DTSTART of 99999999 normalizes
// into such a year. The card would print "Invalid Date", so the event is counted rather than listed.
const isDatable = (date: Date): boolean => date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999;

// The card writes a `mailto:` link from this address, and a `?` passes the shared validator and starts a mailto: URI's
// header fields.
const isPlainAddress = (email: string): boolean => validateEmailAddress(email) && !email.includes('?');

function previewEvent(event: ParsedEvent): IcsPreviewEvent {
    const declared = event.data?.attendees ?? [];
    const attendees = declared.filter((attendee) => isPlainAddress(attendee.email));
    const organizer = event.data?.organizer ?? null;
    return {
        uid: event.uid,
        title: event.title,
        description: event.description?.slice(0, ICS_PREVIEW_MAX_DESCRIPTION_CHARS) ?? null,
        location: event.location,
        start: dateString(event.startTime, event.allDay),
        end: dateString(event.endTime, event.allDay),
        allDay: event.allDay,
        timezone: event.timezone,
        rrule: event.rrule,
        status: event.status,
        organizer: organizer && isPlainAddress(organizer.email) ? organizer : null,
        attendees: attendees.slice(0, ICS_PREVIEW_MAX_ATTENDEES),
        remainingAttendees: Math.max(attendees.length - ICS_PREVIEW_MAX_ATTENDEES, 0),
    };
}

// File bytes → the events an .ics preview serves.
export function buildIcsPreviewPayload(data: ArrayBuffer): IcsPreview {
    // RFC 5545 requires UTF-8, and a file in another encoding is not a calendar stored with replacement characters.
    const text = decodeUtf8Strict(data);
    if (text === null) throw new ApiError(422, 'Could not read this file');
    // The import's own ceiling, before the parser builds anything.
    if (countVEvents(text) > ICS_IMPORT_MAX_EVENTS) throw new ApiError(413, 'Too many events to preview');

    let parsed: IcsParseResult;
    try {
        parsed = parseIcs(text);
    } catch {
        throw new ApiError(422, 'Could not read this file');
    }

    // An override and the cancelled row an EXDATE becomes are parts of their series, which the master's rrule says.
    const masters = parsed.events.filter((event) => event.recurrenceDate === null);
    const datable = masters.filter((event) => isDatable(event.startTime) && isDatable(event.endTime));
    datable.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // An override whose master the file does not hold attaches to no series the card can show, so it counts as unread.
    const masterUids = new Set(masters.map((event) => event.uid));
    const orphans = parsed.events.filter((event) => event.recurrenceDate !== null && !masterUids.has(event.uid)).length;
    const unreadable = parsed.skipped + orphans;

    // What is merely past the cap is the consumer's own `total - dropped - events.length`.
    return {
        method: parsed.method,
        events: datable.slice(0, ICS_PREVIEW_MAX_EVENTS).map(previewEvent),
        dropped: masters.length - datable.length + unreadable,
        total: masters.length + unreadable,
    };
}
