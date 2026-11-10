// The payloads of a file's quick look, served for a Drive file or a mail part alike: a rendered text body, or the
// contact cards, message or events a .vcf, .eml or .ics holds. The preview routes build them and the preview surfaces
// draw them.

import type { TextPreviewMode } from '../constants/preview';
import type { NormalStyle } from '../docs/eigendoc/normal-style';
import type { PageSetup } from '../docs/eigendoc/page';
import type { Attendee, CalendarEvent, ImipMethod, Organizer } from './calendar';
import type { Contact } from './contact';
import type { AddressObject, Attachment } from './mail';

// A rendered HTML body and the mode that frames it, such as prose or a page. A doc's carries the page and the Normal
// style its text is drawn in, which a mail part never has.
export type TextPreviewResult = {
    body: string;
    mode: TextPreviewMode;
    page?: PageSetup;
    style?: NormalStyle;
};

// The cards of a .vcf themselves, not a rendered body: the first readable ones the builder's ceiling admits.
export type VCardPreview = { cards: { contact: Contact; categories: string[] }[]; dropped: number; total: number };

// The fields a quick look draws of an .eml and nothing else, so no part bytes, `bcc` or invite: it reads a message and
// never acts on it. `html` is sanitized, and null when there is none or it is past the payload ceiling.
export type EmlPreview = {
    subject: string;
    from: AddressObject | null;
    to: AddressObject | AddressObject[] | null;
    cc: AddressObject | AddressObject[] | null;
    date: string | null;
    html: string | null;
    text: string | null;
    attachments: Pick<Attachment, 'filename' | 'contentType' | 'size'>[];
    remainingAttachments: number;
};

// `start` and `end` are an ISO instant, or a bare `YYYY-MM-DD` with the exclusive end an all-day event stores.
export type IcsPreviewEvent = Pick<
    CalendarEvent,
    'uid' | 'title' | 'description' | 'location' | 'allDay' | 'timezone' | 'rrule' | 'status'
> & {
    start: string;
    end: string;
    organizer: Organizer | null;
    attendees: Attendee[];
    remainingAttendees: number;
};

// The masters an .ics holds, the first by start the builder's ceiling admits. `method` is the file's own, so an
// invitation reads as one.
export type IcsPreview = { method?: ImipMethod; events: IcsPreviewEvent[]; dropped: number; total: number };
