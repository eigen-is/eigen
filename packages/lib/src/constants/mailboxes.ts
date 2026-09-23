// The special mailboxes every Maildir carries: wire name (the DB column, SSE payloads; inbox = ''), IMAP
// special-use flag and UI label. React-free so the API imports it; icons live in `core/mailbox-icons.ts`.

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

// Every mailbox row carries one of these two; a special one adds its special-use flag after it.
export const MAILBOX_HAS_CHILDREN_FLAG = '\\HasChildren';
export const MAILBOX_NO_CHILDREN_FLAG = '\\HasNoChildren';

const BY_FLAG = new Map<string, SpecialMailbox>(Object.values(SPECIAL_MAILBOXES).map((box) => [box.flag, box]));

const STANDARD_BY_NAME = new Set<string>(STANDARD_MAILBOXES);

// The one name a mailbox answers to: the standard six case-fold onto their canonical spelling and `INBOX`
// onto the inbox's empty name, while a folder the user (or their IMAP client) made keeps its own spelling.
// Both hierarchy delimiters address one directory, so `/` folds onto Maildir++'s `.` here — or the DB
// `mailbox` column, the SSE payloads and the query keys would hold a second spelling of the same folder.
export function canonicalMailbox(mailbox: string): string {
    if (mailbox === MAILBOX_INBOX || mailbox.toLowerCase() === MAILBOX_INBOX_KEY) return MAILBOX_INBOX;
    const dotted = mailbox.replaceAll('/', '.');
    return STANDARD_MAILBOXES.find((m) => m.toLowerCase() === dotted.toLowerCase()) ?? dotted;
}

// Whether a name addresses one of the standard six. A `.archive` or `.INBOX` directory is Archive and the
// Maildir root under another spelling, never a folder of its own.
export function isStandardMailbox(mailbox: string): boolean {
    return STANDARD_BY_NAME.has(canonicalMailbox(mailbox));
}

// The `/box/:filterId` segment and the mailbox part of a list query key. A custom folder travels verbatim:
// the server case-folds only the standard names, so `Projects` lowercased would address no mailbox at all.
export function mailboxRouteSegment(mailbox: string): string {
    if (mailbox === MAILBOX_INBOX) return MAILBOX_INBOX_KEY;
    return isStandardMailbox(mailbox) ? mailbox.toLowerCase() : mailbox;
}

// IMAP modified UTF-7 (RFC 3501 §5.1.3), which is how Dovecot spells a folder name holding `&` or anything
// outside printable ASCII: `&` opens a base64 run that `-` closes, `&-` is a literal `&`, and the base64
// alphabet spells UTF-16BE code units with `,` where base64 has `/`.
const MODIFIED_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,';
const MODIFIED_UTF7_RUN = /&([A-Za-z0-9+,]*)-/g;

function decodeModifiedUtf7(segment: string): string {
    return segment.replace(MODIFIED_UTF7_RUN, (raw, run: string) => {
        if (run === '') return '&';
        let acc = 0;
        let bits = 0;
        let decoded = '';
        for (const char of run) {
            acc = (acc << 6) | MODIFIED_BASE64.indexOf(char);
            bits += 6;
            if (bits >= 16) {
                bits -= 16;
                decoded += String.fromCharCode((acc >>> bits) & 0xffff);
                acc &= (1 << bits) - 1;
            }
        }
        // Leftover bits must be zero padding; anything else was never such a run, so show it as it stands.
        return bits < 6 && acc === 0 ? decoded : raw;
    });
}

// A custom folder's label — a standard one goes by its `SpecialMailbox.label`. The `.` delimiter is shown
// as the `/` a reader takes for nesting, and each segment in the letters it stands for.
export function mailboxDisplayName(mailbox: string): string {
    return mailbox.split('.').map(decodeModifiedUtf7).join('/');
}

// The special mailbox a mailbox row's flags identify, if any — a custom folder matches none.
export function specialMailboxFromFlags(flags: readonly string[] = []): SpecialMailbox | undefined {
    for (const flag of flags) {
        const box = BY_FLAG.get(flag);
        if (box) return box;
    }
    return undefined;
}

// The flags a mailbox is listed with. Eigen nests none itself, but a Dovecot client may, so whether one has
// children is read off the whole enumeration.
export function mailboxListFlags(mailbox: string, allMailboxes: readonly string[]): string[] {
    const prefix = `${mailbox}.`;
    const children = allMailboxes.some((path) => path.startsWith(prefix))
        ? MAILBOX_HAS_CHILDREN_FLAG
        : MAILBOX_NO_CHILDREN_FLAG;
    const box = Object.values(SPECIAL_MAILBOXES).find((special) => special.path === mailbox);
    return box ? [children, box.flag] : [children];
}
