// The Drive actions a viewer is offered on some items: the catalog's rows for the view's capabilities,
// less those this viewer or this server can't use. A catalog gate is handed the items alone, so this
// is the one place that knows who is asking, whether the items were shared with them, and whether the
// server hosts mail. The Drive action runner and an open document's File menu both read it, and the file
// actions' rows pass the same viewer filter.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveAction } from '@workspace/lib/types/drive-actions';
import type { DriveCapabilities } from '@workspace/lib/types/drive-view';
import { useAuth, useIsGuest } from '../../auth';
import { useMailEnabled } from '../../public';
import { driveActionsFor } from '../drive-actions';
import { useIsEffectiveOwnerOf, useIsSharedWithMe } from './use-drive-access';

type ViewerFlags = Pick<DriveAction, 'guestDenied' | 'mailOnly' | 'visitorAllowed'>;

export function useDriveActionsFor(capabilities: DriveCapabilities): (items: readonly DrivePath[]) => DriveAction[] {
    const isSharedWithMe = useIsSharedWithMe();
    const isEffectiveOwnerOf = useIsEffectiveOwnerOf();
    const mayUse = useViewerMayUse();
    return (items) => driveActionsFor({ items, capabilities, isSharedWithMe, isEffectiveOwnerOf }).filter(mayUse);
}

// Whether this viewer on this server may use a catalog row: a visitor only the rows marked for them, a guest none
// that a guest's route refuses, and nobody a mail row on a server without hosted mail.
export function useViewerMayUse(): (row: ViewerFlags) => boolean {
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const mailEnabled = useMailEnabled();
    return (row) =>
        user ? !(isGuest && row.guestDenied) && (mailEnabled || !row.mailOnly) : row.visitorAllowed === true;
}
