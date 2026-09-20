import type { TextPreviewMode } from '../constants/preview';
import type { Attendee, CalendarEvent, EventData, ImipMethod } from './calendar';
import type { Contact } from './contact';
import type { AddressObject, Attachment } from './mail';

// What a text preview serves, from Drive bytes or a mail part alike: a rendered HTML body plus the mode
// that tells a surface how to frame it (prose, a code block, a page-sized document).
export type TextPreviewResult = {
    body: string;
    mode: TextPreviewMode;
};

// What a .vcf preview serves: the cards themselves, not a rendered body — the overlay and the drive hero
// both render them with ContactDetailCard/UserAvatar (packages/ui). `cards` holds the first
// VCARD_PREVIEW_MAX_CARDS readable ones; `dropped` counts the cards the parser refused and `total` the
// cards the file holds, so a surface can say how many it is not showing.
export type VCardPreview = { cards: { contact: Contact; categories: string[] }[]; dropped: number; total: number };

// What an `.eml` preview serves: the header and body fields `MessageView` draws, and nothing else. No part
// bytes, no `bcc`, no invite — a quick look reads a message, it does not act on it. `date` is an ISO instant
// as a string, which is why both routes are read through the no-revival treaty (core/api.ts). `html` is
// sanitized in the Worker and null when there is none or it is over the payload ceiling; `attachments` holds
// the first EML_PREVIEW_MAX_ATTACHMENTS parts and `droppedAttachments` counts the rest.
export type EmlPreview = {
    subject: string;
    from: AddressObject | null;
    to: AddressObject | null;
    cc: AddressObject | null;
    date: string | null;
    html: string | null;
    text: string | null;
    attachments: Pick<Attachment, 'filename' | 'contentType' | 'size'>[];
    droppedAttachments: number;
};

// One event of an `.ics` preview: what `EventDetailCard` draws, and nothing relative to now — the payload
// is cached per file version, so it must not depend on the clock (the card describes the recurrence from
// `rrule` itself). `start` and `end` are strings, not Dates: an ISO instant, or a bare `YYYY-MM-DD` for an
// all-day event with the exclusive end the calendar domain stores — which is why both routes are read
// through the no-revival treaty (core/api.ts). `attendees` holds the first ICS_PREVIEW_MAX_ATTENDEES and
// `droppedAttendees` counts the rest.
export type IcsPreviewEvent = Pick<
    CalendarEvent,
    'uid' | 'title' | 'description' | 'location' | 'allDay' | 'timezone' | 'rrule' | 'status'
> & {
    start: string;
    end: string;
    organizer: NonNullable<EventData['organizer']> | null;
    attendees: Attendee[];
    droppedAttendees: number;
};

// What an `.ics` preview serves: the events the file holds, masters only — an override or an excluded
// occurrence is part of its series, not a row of its own. `events` holds the first
// ICS_PREVIEW_MAX_EVENTS by start, `dropped` counts the rest and `total` the masters the file holds.
// `method` is the file's own METHOD, so an invitation reads as one.
export type IcsPreview = { method?: ImipMethod; events: IcsPreviewEvent[]; dropped: number; total: number };
