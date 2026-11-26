// The Drive actions a viewer is offered on some items: the catalog's rows for the view's capabilities,
// less those this viewer or this server can't use. A catalog gate is handed the items alone, so this
// is the one place that knows who is asking, whether the items were shared with them, and whether the
// server hosts mail. A visitor, with no login, only opens. The Drive action runner and an open
// document's File menu both read it.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveAction } from '@workspace/lib/types/drive-actions';
import type { DriveCapabilities } from '@workspace/lib/types/drive-view';
import { useAuth, useIsGuest } from '../../auth';
import { useMailEnabled } from '../../public';
import { driveActionsFor } from '../drive-actions';
import { useIsSharedWithMe } from './use-drive-access';

export function useDriveActionsFor(capabilities: DriveCapabilities): (items: readonly DrivePath[]) => DriveAction[] {
    const { user } = useAuth();
    const isSharedWithMe = useIsSharedWithMe();
    const isGuest = useIsGuest();
    const mailEnabled = useMailEnabled();
    return (items) =>
        driveActionsFor({ items, capabilities, isSharedWithMe }).filter((action) =>
            user ? !(isGuest && action.guestDenied) && (mailEnabled || !action.mailOnly) : action.id === 'open',
        );
}
