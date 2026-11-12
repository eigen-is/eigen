// The shapes of the Drive actions a Drive view's menus offer, such as rename, move or trash: a row's
// label, icon and menu group, and the facts its gate reads. DRIVE_ACTIONS lists the rows themselves.

import type { LucideIcon } from 'lucide-react';
import type { DrivePath } from './drive';
import type { DriveCapabilities } from './drive-view';

export type DriveActionId =
    | 'open'
    | 'open-new-tab'
    | 'rename'
    | 'duplicate'
    | 'move-to'
    | 'copy-to'
    | 'download-as'
    | 'share'
    | 'email-collaborators'
    | 'copy-link'
    | 'mail-to'
    | 'trash'
    | 'remove-shared';

// The menu group a Drive action's row sits in, named as MenuSections names it.
export type DriveActionGroup = 'open' | 'create' | 'organize' | 'output' | 'collaborate' | 'destructive';

// The facts a Drive action's gate reads: the items it acts on, what the view allows, and which items were
// shared with the viewer.
export type DriveActionSubject = {
    items: readonly DrivePath[];
    capabilities: DriveCapabilities;
    // True for an item the viewer reaches through a direct share. Deleting it leaves the share, and the
    // server refuses a copy into its owner's folder.
    isSharedWithMe: (item: DrivePath) => boolean;
};

export type DriveAction = {
    id: DriveActionId;
    label: string;
    // The label for a multi-selection, {n} standing for the count. Only a row that acts on a set has one.
    pluralLabel?: string;
    icon: LucideIcon;
    group: DriveActionGroup;
    applies: (subject: DriveActionSubject) => boolean;
    // The hotkey that runs the row from a Drive listing, which the listing's menu names beside it.
    shortcut?: string;
    // The route behind the row refuses a guest, and `applies` is never told who is asking.
    guestDenied?: true;
    // The row reaches the hosted mailbox, so a server without hosted mail hides it.
    mailOnly?: true;
};
