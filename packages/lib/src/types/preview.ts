import type { TextPreviewMode } from '../constants/preview';
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
