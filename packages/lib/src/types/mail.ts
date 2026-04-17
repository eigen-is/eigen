import type { ImipMethod } from './calendar';

export type StructuredHeader = {
    value: string;
    params: { [key: string]: string };
};

export type HeaderValue = string | string[] | AddressObject | Date | StructuredHeader | StructuredHeader[];

export type Headers = Map<string, HeaderValue>;

export type HeaderLines = ReadonlyArray<{
    key: string;
    line: string;
}>;

export type EmailAddress = {
    address?: string | undefined;
    name: string;
    group?: EmailAddress[] | undefined;
};

export type AddressObject = {
    value: EmailAddress[];
    html: string;
    text: string;
};

export type Attachment = {
    type: 'attachment';
    content: unknown;
    contentType: string;
    contentDisposition: string;
    filename?: string | undefined;
    headers: Headers;
    headerLines: HeaderLines;
    checksum: string;
    size: number;
    contentId?: string | undefined;
    cid?: string | undefined;
    related: boolean;
    calendarMethod?: ImipMethod;
};

export type ParsedMail = {
    attachments: Attachment[];
    headers: Headers;
    headerLines: HeaderLines;
    html: string | false;
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
    priority?: 'normal' | 'low' | 'high' | undefined;
};

export type EmailSummary = {
    id: string;
    filename: string;
    subject: string;
    fromShort: string;
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

export type Email = ParsedMail & EmailSummary;

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

/** The minimal shape produced by createDraftEmail and accepted by the draft/send API. */
export type NewDraft = {
    id?: string;
    subject?: string;
    text?: string;
    html?: string | false;
    from?: AddressObject;
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
    isDraft: boolean;
    mailbox: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string[] | string;
};

export type DraftInput = {
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
    subject?: string;
    text?: string;
    html?: string;
};

export type AttachmentMeta = {
    tempId?: string;
    filename: string;
    size: number;
    contentType: string;
    index?: number;
    localUrl?: string;
};
