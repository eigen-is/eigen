import type { ImipMethod } from './calendar';
import type { AttachmentReference } from './drive-reference';

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
    // Byte length of content; the detail payload blanks content, so the compose UI reads this instead.
    size: number;
    calendarMethod?: ImipMethod;
    // Set on text/calendar attachments in the message-detail payload; null = unparseable ICS.
    calendarInvite?: CalendarInvite | null;
};

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

export type Email = ParsedMail &
    EmailSummary & {
        // Populated only on drafts (read from the sidecar). Absent on sent/received mail —
        // for those, references are baked into the HTML body when the draft was finalized.
        driveReferences?: AttachmentReference[];
    };

export type MaildirMailbox = {
    path: string;
    name: string;
    delimiter: string;
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
};

export type DraftInput = {
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string[] | string;
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
    // Position of the parsed attachment in the on-disk EML (for download URLs).
    index?: number;
    // Blob URL for local image thumbnails — not sent to the server.
    localUrl?: string;
};
