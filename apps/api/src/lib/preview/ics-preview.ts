import {
    ICS_PREVIEW_MAX_ATTENDEES,
    ICS_PREVIEW_MAX_DESCRIPTION_CHARS,
    ICS_PREVIEW_MAX_EVENTS,
} from '@workspace/lib/constants/calendar';
import type { IcsPreview, IcsPreviewEvent } from '@workspace/lib/types/preview';
import { validateEmailAddress } from '@workspace/lib/validation';
import { type IcsParseResult, type ParsedEvent, parseIcs } from '../caldav/ical-parse';
import { ApiError } from '../core/errors';

// A cached body is JSON this process wrote from a value it built, so the read back is a typed assignment,
// like the vCard and message previews beside it. Nothing else checks the shape: change IcsPreview and
// bump ICS_FORMAT (preview-cache.ts), or a restored previewsDir serves the old shape.
export const parseIcsPreview = (body: string): IcsPreview => JSON.parse(body);

// An all-day event is stored as UTC midnight with an exclusive end, which is the pair the card reads back.
const dateString = (date: Date, allDay: boolean): string =>
    allDay ? date.toISOString().slice(0, 10) : date.toISOString();

// toISOString spells a year outside 1–9999 with a sign and six digits ("+010007-06-07T…"), and the
// all-day slice of that is not a date at all — a DTSTART of 99999999 normalizes its month and day into
// the year. The card would print "Invalid Date", so the event is counted rather than listed.
const isDatable = (date: Date): boolean => date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999;

function previewEvent(event: ParsedEvent): IcsPreviewEvent {
    // A CAL-ADDRESS is a URI and only a mailto: one names an address, which parseIcs strips the scheme
    // off. Anything else the file spells reaches the card as an address it writes a `mailto:` link from,
    // so it is omitted — not one more guest the card promises to be hiding.
    const declared = event.data?.attendees ?? [];
    const attendees = declared.filter((attendee) => validateEmailAddress(attendee.email));
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
        organizer: organizer && validateEmailAddress(organizer.email) ? organizer : null,
        attendees: attendees.slice(0, ICS_PREVIEW_MAX_ATTENDEES),
        remainingAttendees: Math.max(attendees.length - ICS_PREVIEW_MAX_ATTENDEES, 0),
    };
}

// File bytes → the events an .ics preview serves. Runs inside the transform Worker (worker.ts owns
// execution; the main-thread orchestration lives in preview-cache.ts). This module must not reach the
// Mount or the transform seam — the Worker imports it.
export function buildIcsPreviewPayload(data: ArrayBuffer): IcsPreview {
    let parsed: IcsParseResult;
    try {
        // The same fatal decode the vCard build takes: RFC 5545 requires UTF-8, and a file in another
        // encoding is not a calendar stored with replacement characters.
        parsed = parseIcs(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch {
        throw new ApiError(422, 'Could not read this file');
    }

    // Masters only: an override VEVENT and the synthetic cancelled row an EXDATE becomes are parts of
    // their series, which the master's own rrule already says.
    const masters = parsed.events.filter((event) => event.recurrenceDate === null);
    const datable = masters.filter((event) => isDatable(event.startTime) && isDatable(event.endTime));
    datable.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // `dropped` is the masters the builder could not read, as it is in every preview payload; the ones
    // merely past the cap are the consumer's own `total - dropped - events.length`.
    return {
        method: parsed.method,
        events: datable.slice(0, ICS_PREVIEW_MAX_EVENTS).map(previewEvent),
        dropped: masters.length - datable.length,
        total: masters.length,
    };
}
