import type { IcsPreview, IcsPreviewEvent } from '@workspace/lib/types/preview';
import { validateEmailAddress } from '@workspace/lib/validation';
import { ApiError } from '../core/errors';
import {
    decodeUtf8Strict,
    ICS_PREVIEW_MAX_ATTENDEES,
    ICS_PREVIEW_MAX_DESCRIPTION_CHARS,
    ICS_PREVIEW_MAX_EVENTS,
} from '../core/transfer';
import { parseIcs } from '../ical';
import type { IcsParseResult, ParsedEvent } from '../ical/ical-parse';

export const parseIcsPreview = (body: string): IcsPreview => JSON.parse(body);

// An all-day event is stored as UTC midnight with an exclusive end, which is the pair the card reads back.
const dateString = (date: Date, allDay: boolean): string =>
    allDay ? date.toISOString().slice(0, 10) : date.toISOString();

// toISOString spells a year outside 1–9999 with a sign and six digits ("+010007-06-07T…"), and the
// all-day slice of that is not a date at all — a DTSTART of 99999999 normalizes its month and day into
// the year. The card would print "Invalid Date", so the event is counted rather than listed.
const isDatable = (date: Date): boolean => date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999;

// A CAL-ADDRESS is a URI and only a mailto: one names an address, which parseIcs strips the scheme off.
// Anything else the file spells reaches the card as an address it writes a `mailto:` link from, so it is
// omitted — not one more guest the card promises to be hiding. A `?` passes the shared validator and
// starts a mailto: URI's header fields, so an address carrying one is not a plain address either.
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
    // The same fatal decode the vCard build takes: RFC 5545 requires UTF-8, and a file in another
    // encoding is not a calendar stored with replacement characters.
    const text = decodeUtf8Strict(data);
    if (text === null) throw new ApiError(422, 'Could not read this file');

    let parsed: IcsParseResult;
    try {
        parsed = parseIcs(text);
    } catch {
        throw new ApiError(422, 'Could not read this file');
    }

    // Masters only: an override VEVENT and the synthetic cancelled row an EXDATE becomes are parts of
    // their series, which the master's own rrule already says.
    const masters = parsed.events.filter((event) => event.recurrenceDate === null);
    const datable = masters.filter((event) => isDatable(event.startTime) && isDatable(event.endTime));
    datable.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // A VEVENT the parser could not read, and an override whose master the file does not hold — it
    // attaches to no series the card can show — are members like any other: counted, not silently gone.
    const masterUids = new Set(masters.map((event) => event.uid));
    const orphans = parsed.events.filter((event) => event.recurrenceDate !== null && !masterUids.has(event.uid)).length;
    const unreadable = parsed.skipped + orphans;

    // `dropped` is the members the builder could not read, as it is in every preview payload; the ones
    // merely past the cap are the consumer's own `total - dropped - events.length`.
    return {
        method: parsed.method,
        events: datable.slice(0, ICS_PREVIEW_MAX_EVENTS).map(previewEvent),
        dropped: masters.length - datable.length + unreadable,
        total: masters.length + unreadable,
    };
}
