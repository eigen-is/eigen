// The things a user can do with Drive items in a Drive view, such as rename, move, share or trash, each
// with its label, its gate and the key that runs it. Surfaces such as the Drive item menu and the command
// palette draw their rows from driveActionsFor and word them with labelFor. File actions that any surface
// offers, such as Quick preview, are a separate list, FILE_ACTIONS. Watch is not a row here: it shows the
// item's live watch state, so the surfaces draw it from useWatchToggle.

import {
    ArrowRight,
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
import { DELETE_HOTKEY } from '../../constants/hotkeys';
import { exportFormatsFor } from '../../types/drive';
import type { DriveAction, DriveActionSubject } from '../../types/drive-actions';
import { isOpenable } from '../../types/file-kinds';
import { getDriveItemUrl } from '../api';

const one = ({ items }: DriveActionSubject) => items.length === 1;

// A row with a plural label is one a multi-selection offers too; the others act on a single item.
const DRIVE_ACTIONS: readonly DriveAction[] = [
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
        // A copy lands beside its source, so a root has no folder to land in. An item shared with the
        // viewer sits in its owner's folder, where the server refuses the copy.
        applies: (s) =>
            s.capabilities.canWrite &&
            s.items.every((item) => item.parentId !== null) &&
            !s.items.some(s.isSharedWithMe),
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
    {
        id: 'trash',
        label: 'Move to trash',
        pluralLabel: 'Move {n} items to trash',
        icon: Trash2,
        group: 'destructive',
        applies: (s) => s.capabilities.canDelete && !s.items.every(s.isSharedWithMe),
        shortcut: DELETE_HOTKEY,
    },
    {
        id: 'remove-shared',
        label: 'Remove shared item',
        pluralLabel: 'Remove {n} shared items',
        icon: Trash2,
        group: 'destructive',
        // The server leaves a direct share instead of trashing it, so the row says so.
        applies: (s) => s.capabilities.canDelete && s.items.every(s.isSharedWithMe),
        shortcut: DELETE_HOTKEY,
    },
];

// Nothing selected offers nothing, so no row opens a dialog with no items in it.
export function driveActionsFor(subject: DriveActionSubject): DriveAction[] {
    if (subject.items.length === 0) return [];
    return DRIVE_ACTIONS.filter((action) => action.applies(subject));
}

// A row's label for the items it acts on: a multi-selection reads the plural label, its {n} the count.
export function labelFor({ label, pluralLabel }: Pick<DriveAction, 'label' | 'pluralLabel'>, count: number): string {
    return count > 1 && pluralLabel ? pluralLabel.replace('{n}', String(count)) : label;
}
