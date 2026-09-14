// The special mailboxes every Maildir carries: their canonical wire names, the IMAP special-use flag each
// one advertises, and the label the UI shows for it. The wire name is what the DB `mailbox` column, the SSE
// payloads and `canonicalMailbox()` speak, and there the inbox is the empty string. Icons sit beside this in
// `core/mailbox-icons.ts`; they need React, and this module stays React-free so the API can import it.

export const MAILBOX_INBOX = '';
export const MAILBOX_SENT = 'Sent';
export const MAILBOX_DRAFTS = 'Drafts';
export const MAILBOX_TRASH = 'Trash';
export const MAILBOX_JUNK = 'Junk';
export const MAILBOX_ARCHIVE = 'Archive';

// The inbox as the frontend spells it: query keys and `/box/:filterId` segments lowercase every mailbox, and
// the canonical inbox has no lowercase form, so it travels as this instead.
export const MAILBOX_INBOX_KEY = 'inbox';

// The inbox as IMAP and the Maildir on disk name it — the root folder, not a `.Mailbox` subdirectory.
export const MAILBOX_INBOX_IMAP = 'INBOX';

export type StandardMailbox =
    | typeof MAILBOX_INBOX
    | typeof MAILBOX_SENT
    | typeof MAILBOX_DRAFTS
    | typeof MAILBOX_TRASH
    | typeof MAILBOX_JUNK
    | typeof MAILBOX_ARCHIVE;

export type SpecialMailbox = {
    path: StandardMailbox;
    // RFC 6154 special-use attribute (plus `\Inbox`), as carried on every mailbox row's `flags`.
    flag: string;
    // What the UI calls it: `Junk` reads as "Spam".
    label: string;
};

export const SPECIAL_MAILBOXES: Record<StandardMailbox, SpecialMailbox> = {
    [MAILBOX_INBOX]: { path: MAILBOX_INBOX, flag: '\\Inbox', label: 'Inbox' },
    [MAILBOX_SENT]: { path: MAILBOX_SENT, flag: '\\Sent', label: 'Sent' },
    [MAILBOX_DRAFTS]: { path: MAILBOX_DRAFTS, flag: '\\Drafts', label: 'Drafts' },
    [MAILBOX_TRASH]: { path: MAILBOX_TRASH, flag: '\\Trash', label: 'Trash' },
    [MAILBOX_JUNK]: { path: MAILBOX_JUNK, flag: '\\Junk', label: 'Spam' },
    [MAILBOX_ARCHIVE]: { path: MAILBOX_ARCHIVE, flag: '\\Archive', label: 'Archive' },
};

// Creation order: the Maildir folders are made and the `.subscriptions` file written in this order.
export const STANDARD_MAILBOXES: readonly StandardMailbox[] = [
    MAILBOX_INBOX,
    MAILBOX_SENT,
    MAILBOX_DRAFTS,
    MAILBOX_TRASH,
    MAILBOX_JUNK,
    MAILBOX_ARCHIVE,
];

// Sidebar order, which reads differently from the creation order above (drafts before sent, trash before
// archive). It also orders the fallback list the sidebar shows while the mailboxes are still loading.
export const SIDEBAR_MAILBOXES: readonly SpecialMailbox[] = (
    [MAILBOX_INBOX, MAILBOX_DRAFTS, MAILBOX_SENT, MAILBOX_JUNK, MAILBOX_TRASH, MAILBOX_ARCHIVE] as const
).map((path) => SPECIAL_MAILBOXES[path]);

// Every mailbox row carries this; a special one adds its special-use flag after it.
export const MAILBOX_NO_CHILDREN_FLAG = '\\HasNoChildren';

const BY_PATH = new Map<string, SpecialMailbox>(Object.values(SPECIAL_MAILBOXES).map((box) => [box.path, box]));
const BY_FLAG = new Map<string, SpecialMailbox>(Object.values(SPECIAL_MAILBOXES).map((box) => [box.flag, box]));

// The `/box/:filterId` segment, and the mailbox part of a list query key: every mailbox lowercased, with
// the canonical empty inbox spelled out.
export function mailboxRouteSegment(mailbox: string): string {
    return mailbox.toLowerCase() || MAILBOX_INBOX_KEY;
}

// The special mailbox a mailbox row's flags identify, if any — a custom folder matches none.
export function specialMailboxFromFlags(flags: readonly string[] = []): SpecialMailbox | undefined {
    for (const flag of flags) {
        const box = BY_FLAG.get(flag);
        if (box) return box;
    }
    return undefined;
}

// The flags a mailbox is listed with. Eigen nests no mailboxes, so every one of them has no children.
export function mailboxListFlags(mailbox: string): string[] {
    const box = BY_PATH.get(mailbox);
    return box ? [MAILBOX_NO_CHILDREN_FLAG, box.flag] : [MAILBOX_NO_CHILDREN_FLAG];
}
