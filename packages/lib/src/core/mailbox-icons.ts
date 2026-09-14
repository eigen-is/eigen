import {
    MAILBOX_ARCHIVE,
    MAILBOX_DRAFTS,
    MAILBOX_INBOX,
    MAILBOX_JUNK,
    MAILBOX_SENT,
    MAILBOX_TRASH,
    type StandardMailbox,
} from '@workspace/lib/constants/mailboxes';
import { AlertOctagon, Archive, File, Inbox, type LucideIcon, Send, Trash2 } from 'lucide-react';

// Sibling-of-SPECIAL_MAILBOXES icon registry. Kept out of constants/mailboxes.ts so that module stays
// React-free on the BE side. Single source for the lucide icon of each special mailbox.
export const MAILBOX_ICONS: Record<StandardMailbox, LucideIcon> = {
    [MAILBOX_INBOX]: Inbox,
    [MAILBOX_SENT]: Send,
    [MAILBOX_DRAFTS]: File,
    [MAILBOX_TRASH]: Trash2,
    [MAILBOX_JUNK]: AlertOctagon,
    [MAILBOX_ARCHIVE]: Archive,
};

// A mailbox the user made themselves has no special-use flag and so no icon of its own.
export const CUSTOM_MAILBOX_ICON: LucideIcon = File;
