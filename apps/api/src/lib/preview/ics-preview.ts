import {
    ICS_PREVIEW_MAX_ATTENDEES,
    ICS_PREVIEW_MAX_DESCRIPTION_CHARS,
    ICS_PREVIEW_MAX_EVENTS,
} from '@workspace/lib/constants/calendar';
import type { IcsPreview, IcsPreviewEvent } from '@workspace/lib/types/preview';
import { type IcsParseResult, type ParsedEvent, parseIcs } from '../caldav/ical-parse';
import { ApiError } from '../core/errors';

// A cached body is JSON this process wrote from a value it built, so the read back is a typed assignment,
// like the vCard and message previews beside it. Nothing else checks the shape: change IcsPreview and
// bump ICS_FORMAT (preview-cache.ts), or a restored previewsDir serves the old shape.
export const parseIcsPreview = (body: string): IcsPreview => JSON.parse(body);

// An all-day event is stored as UTC midnight with an exclusive end, which is the pair the card reads back.
const dateString = (date: Date, allDay: boolean): string =>
    allDay ? date.toISOString().slice(0, 10) : date.toISOString();

function previewEvent(event: ParsedEvent): IcsPreviewEvent {
    const attendees = event.data?.attendees ?? [];
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
        organizer: event.data?.organizer ?? null,
        attendees: attendees.slice(0, ICS_PREVIEW_MAX_ATTENDEES),
        droppedAttendees: Math.max(attendees.length - ICS_PREVIEW_MAX_ATTENDEES, 0),
    };
}

// File bytes → the events an .ics preview serves. Runs inside the transform Worker (worker.ts owns
// execution; the main-thread orchestration lives in preview-cache.ts). This module must not reach the
// Mount or the transform seam — the Worker imports it.
//
// The payload makes no request when it renders: parseIcs keeps what the event columns model, so an
// ATTACH, a URL and a directory reference never leave this function.
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
    masters.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    return {
        method: parsed.method,
        events: masters.slice(0, ICS_PREVIEW_MAX_EVENTS).map(previewEvent),
        dropped: Math.max(masters.length - ICS_PREVIEW_MAX_EVENTS, 0),
        total: masters.length,
    };
}
