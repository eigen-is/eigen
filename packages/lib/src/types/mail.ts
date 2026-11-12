// The shapes the mail app and its API share: an address, a parsed message and its list row, a draft and what a save and
// a send answer. The routes return them and the mail hooks read them.

import type { ImipMethod } from './calendar';
import type { AttachmentReference } from './drive-reference';
import { isIcsMime } from './file-kinds';

export type EmailAddress = {
    address?: string | undefined;
    name: string;
    group?: EmailAddress[] | undefined;
};

export type AddressObject = {
    value: EmailAddress[];
    text: string;
};

// A text/calendar attachment summarized at message-read time by the API's canonical ical.js
// parser (summarizeCalendarInvite). Dates are real Dates on the FE via Eden's reviver.
export type CalendarInvite = {
    method: ImipMethod;
    uid: string;
    summary: string;
    startTime: Date;
    endTime: Date;
    allDay: boolean;
    timezone: string | null;
    location: string | null;
    organizer: { email: string; name?: string } | null;
};

export type Attachment = {
    contentType: string;
    filename?: string | undefined;
    content: Uint8Array;
    // Raw position in the message's part list. Every part route addresses a part by it.
    index: number;
    // Byte length of content; the detail payload blanks content, so the compose UI reads this instead.
    size: number;
    // The charset the part declares, kept for text parts: the bytes are not UTF-8 unless they say so.
    charset?: string;
    calendarMethod?: ImipMethod;
    // Set on text/calendar attachments in the message-detail payload; null = unparseable or too large.
    calendarInvite?: CalendarInvite | null;
};

// The one name for a part (chip, Content-Disposition, saved file); sender-written, so basename only.
export function mailAttachmentName(att: Pick<Attachment, 'filename'>, index: number): string {
    const name = (att.filename ?? '').replace(/\p{Cc}/gu, '').replace(/^.*[/\\]/, '');
    return name || `attachment-${index + 1}`;
}

// The one test for "this part is an invitation": the reader's invite widget and the iMIP paths ask it.
export function isCalendarPart(att: Pick<Attachment, 'contentType'>): boolean {
    return isIcsMime(att.contentType);
}

export type ParsedMail = {
    attachments: Attachment[];
    html: string | null;
    text?: string | undefined;
    textAsHtml?: string | undefined;
    subject?: string | undefined;
    references?: string[] | string | undefined;
    date?: Date | undefined;
    to?: AddressObject | AddressObject[] | undefined;
    from?: AddressObject | undefined;
    cc?: AddressObject | AddressObject[] | undefined;
    bcc?: AddressObject | AddressObject[] | undefined;
    replyTo?: AddressObject | undefined;
    messageId?: string | undefined;
    inReplyTo?: string | undefined;
    // The message a draft answers, by its id here. Read off the message, so it can name anything or nothing.
    repliedToId?: string | undefined;
    // Raw `Authentication-Results` header values, in document order (topmost first). The verifying
    // MTA prepends its own, so the first entry stamped with our authserv-id is the trusted one.
    authenticationResults?: string[] | undefined;
};

export type EmailSummary = {
    id: string;
    filename: string;
    subject: string;
    fromShort: string;
    fromAddress: string;
    toShort: string;
    toAddress: string;
    recipientsAll: string;
    textShort: string;
    date: Date;
    isRead: boolean;
    isFlagged: boolean;
    isDraft: boolean;
    isReplied: boolean;
    hasAttachments: boolean;
    mailbox: string;
    size: number;
};

export type RecipientSummary = Pick<EmailSummary, 'toShort' | 'toAddress' | 'recipientsAll'>;

export type Email = ParsedMail &
    EmailSummary & {
        // Only a draft's read fills this. A sent or received message shows them as links in its body.
        driveReferences?: AttachmentReference[];
    };

export type MaildirMailbox = {
    path: string;
    flags: string[];
    total: number;
    unread: number;
};

export type EmailDraft = Omit<Email, 'to' | 'cc' | 'bcc'> & {
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
};

// Drafts are produced by our own serializer, so to/cc/bcc are always a single AddressObject
// (never an array). TS can't infer this from isDraft alone — this guard asserts the invariant.
export function isEmailDraft(email: Email | null | undefined): email is EmailDraft {
    return !!email?.isDraft;
}

// Result of a send: the finalized draft plus the addresses whose per-recipient copy failed
// delivery. `failedRecipients` is present only when a partial failure occurred.
export type SentMailResult = EmailDraft & { failedRecipients?: string[] };

// What importing one `.eml` yields: the message it became, by the id every other mail route addresses.
export type ImportMailResult = { id: string };

export type NewDraft = {
    id?: string;
    subject?: string;
    text?: string;
    html?: string;
    from?: AddressObject;
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
    messageId?: string;
    inReplyTo?: string;
    references?: string[] | string;
    driveReferences?: AttachmentReference[];
    // The message this one answers, marked replied once it is sent.
    repliedToId?: string;
};

export type DraftInput = Pick<NewDraft, 'to' | 'cc' | 'bcc' | 'subject' | 'text' | 'html' | 'inReplyTo' | 'references'>;

// Sent with a draft save: staged uploads to embed and parsed attachments to keep.
export type DraftUpdateOptions = {
    tempAttachmentIds?: string[];
    // The parts that stay, by name and size, so a list sent twice keeps the same parts. Left out, every part stays.
    keepAttachments?: Pick<AttachmentMeta, 'filename' | 'size'>[];
};

export type DraftAttachmentUpload = {
    tempId: string;
    filename: string;
    size: number;
    contentType: string;
};

export type AttachmentMeta = {
    // Stable client-side identity for React keys.
    key: string;
    // Present while the binary is still staged on the server and not yet embedded in the draft EML.
    tempId?: string;
    filename: string;
    size: number;
    contentType: string;
    // Blob URL for local image thumbnails — not sent to the server.
    localUrl?: string;
};
