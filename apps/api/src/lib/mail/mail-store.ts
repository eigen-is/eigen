// The shapes the mail part of a Home and its Maildir store hand each other: a search, a flag and the
// change events the store surfaces. Only the types live here, so the domain class and the store don't
// import each other for them.

import type { Email } from '@workspace/lib/types/mail';

export type MailSearchOptions = {
    q: string;
    limit: number;
    mailboxes?: string[];
    from?: string;
    to?: string;
};

export type MailFlag = 'seen' | 'replied' | 'flagged' | 'draft' | 'trashed' | 'forwarded';

// Change stream surfaced by the store's own discovery (sync + fs.watch for Maildir). The Mail
// domain turns these into SSE + notifications.
export type MailStoreEvents = {
    received: (email: Email, isNew: boolean) => void;
    flagsChanged: (messageId: string, mailbox: string) => void;
    deleted: (messageId: string, mailbox: string) => void;
};
