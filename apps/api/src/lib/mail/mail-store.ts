// The shapes the mail part of a Home and its Maildir store hand each other: a search, a draft's sidecar,
// a flag and the change events the store surfaces. Only the types live here, so the domain class and the
// store don't import each other for them.

import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { AddressObject, Email } from '@workspace/lib/types/mail';

export type MailSearchOptions = {
    q: string;
    limit: number;
    mailboxes?: string[];
    from?: string;
    to?: string;
};

// One entry per named, non-calendar part of a draft EML, under the part's raw index, the number a keep list addresses.
export type DraftMetaAttachment = { filename: string; contentType: string; size: number; index: number };

export type DraftMeta = {
    subject: string;
    to?: AddressObject;
    cc?: AddressObject;
    bcc?: AddressObject;
    text: string;
    // "Clean" body as typed by the user — without the reference-card HTML that the EML
    // on disk has baked in. Overlaid on messageGet so the compose view shows what the
    // user typed, not the rendered card block at the bottom.
    html: string;
    attachments: DraftMetaAttachment[];
    driveReferences?: AttachmentReference[];
    inReplyTo?: string;
    references?: string[] | string;
    repliedToId?: string;
    lastFullSaveAt?: number;
};

export type MailFlag = 'seen' | 'replied' | 'flagged' | 'draft' | 'trashed' | 'forwarded';

// Change stream surfaced by the store's own discovery (sync + fs.watch for Maildir). The Mail
// domain turns these into SSE + notifications.
export type MailStoreEvents = {
    received: (email: Email, isNew: boolean) => void;
    flagsChanged: (messageId: string, mailbox: string) => void;
    deleted: (messageId: string, mailbox: string) => void;
};
