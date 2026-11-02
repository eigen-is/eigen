// The things a user can do with Drive items in a Drive view, such as rename, move, share or trash, each
// with its label and the gate that says when it applies. The Drive item menu and the detail column draw
// their rows from driveActionsFor. File actions that any surface offers, such as Quick preview or a
// convert, are a separate list, FILE_ACTIONS.

import {
    ArrowRight,
    Bell,
    Copy,
    CopyPlus,
    ExternalLink,
    FileDown,
    FolderInput,
    Link,
    Mail,
    Pencil,
    Trash2,
    UserRoundPlus,
} from 'lucide-react';
import { exportFormatsFor, isOpenable } from '../../types/drive';
import type { DriveAction, DriveActionSubject } from '../../types/drive-actions';
import { getDriveItemUrl } from '../api';

const one = ({ items }: DriveActionSubject) => items.length === 1;

// A row with a plural label is one a multi-selection offers too; the others act on a single item.
export const DRIVE_ACTIONS: readonly DriveAction[] = [
    { id: 'open', label: 'Open', icon: ArrowRight, group: 'open', applies: (s) => one(s) && isOpenable(s.items[0]) },
    {
        id: 'open-new-tab',
        label: 'Open in new tab',
        icon: ExternalLink,
        group: 'open',
        // A plain file has no page of its own to open.
        applies: (s) => one(s) && !!getDriveItemUrl(s.items[0]),
    },
    {
        id: 'rename',
        label: 'Rename',
        icon: Pencil,
        group: 'create',
        applies: (s) => one(s) && s.capabilities.canRename,
    },
    {
        id: 'duplicate',
        label: 'Duplicate',
        pluralLabel: 'Duplicate {n} items',
        icon: CopyPlus,
        group: 'create',
        // A copy lands beside its source, and a root has no folder to land in.
        applies: (s) => s.capabilities.canWrite && s.items.every((item) => item.parentId !== null),
    },
    {
        id: 'move-to',
        label: 'Move to…',
        pluralLabel: 'Move {n} items to…',
        icon: FolderInput,
        group: 'organize',
        applies: (s) => s.capabilities.canMove,
    },
    // Copy goes anywhere the viewer can write, so reading the items is enough.
    {
        id: 'copy-to',
        label: 'Copy to…',
        pluralLabel: 'Copy {n} items to…',
        icon: Copy,
        group: 'organize',
        applies: () => true,
    },
    {
        id: 'download-as',
        label: 'Download',
        icon: FileDown,
        group: 'output',
        applies: (s) => one(s) && exportFormatsFor(s.items[0].type).length > 0,
    },
    {
        id: 'share',
        label: 'Share',
        icon: UserRoundPlus,
        group: 'collaborate',
        applies: (s) => one(s) && s.capabilities.canShare,
    },
    {
        id: 'email-collaborators',
        label: 'Email collaborators',
        icon: Mail,
        group: 'collaborate',
        // Only an item someone else can see has collaborators to mail.
        applies: (s) =>
            one(s) && s.capabilities.canShare && (!!s.items[0].acl?.length || s.items[0].visibility !== 'private'),
        guestDenied: true,
    },
    // A link or a mail only hands out what the recipient may already open, so reading is enough.
    { id: 'copy-link', label: 'Copy link', icon: Link, group: 'collaborate', applies: one },
    {
        id: 'mail-to',
        label: 'Mail to…',
        pluralLabel: 'Mail {n} items to…',
        icon: Mail,
        group: 'collaborate',
        applies: () => true,
        mailOnly: true,
    },
    { id: 'watch', label: 'Watch', icon: Bell, group: 'collaborate', applies: one },
    {
        id: 'trash',
        label: 'Move to trash',
        pluralLabel: 'Move {n} items to trash',
        icon: Trash2,
        group: 'destructive',
        applies: (s) => s.capabilities.canDelete && !s.sharedWithMe,
        shortcut: 'Delete',
    },
    {
        id: 'remove-shared',
        label: 'Remove shared item',
        pluralLabel: 'Remove {n} shared items',
        icon: Trash2,
        group: 'destructive',
        // The server leaves a direct share instead of trashing it, so the row says so.
        applies: (s) => s.capabilities.canDelete && s.sharedWithMe,
        shortcut: 'Delete',
    },
];

// Nothing selected offers nothing, so no row opens a dialog with no items in it.
export function driveActionsFor(subject: DriveActionSubject): DriveAction[] {
    if (subject.items.length === 0) return [];
    return DRIVE_ACTIONS.filter((action) => action.applies(subject));
}
