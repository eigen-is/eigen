// The capability presets a Drive view starts from: the full folder browser, a flat listing and a
// read-only feed. A view picks one, spreads in its own overrides and hands the value to DriveLayout,
// whose action runner gates every Drive action on it.

import type { EigenDocType } from '@workspace/lib/types/drive';
import type { DriveCapabilities } from '@workspace/lib/types/drive-view';

export const DRIVE_CAPABILITIES = {
    // The full folder browser (the fs route): create, upload, rearrange.
    browse: {
        canCreateFolder: true,
        canUpload: true,
        canWrite: true,
        canDelete: true,
        canRename: true,
        canMove: true,
        canShare: true,
        showBreadcrumb: true,
    },
    // Flat views over existing items (mime filters, per-app doc lists): act on the items, but no
    // folder ops. They also list items shared with the viewer, whose drive the move picker can't open.
    listing: {
        canCreateFolder: false,
        canUpload: false,
        canWrite: true,
        canDelete: true,
        canRename: true,
        canMove: false,
        canShare: true,
        showBreadcrumb: false,
        createTypes: new Set<EigenDocType>(),
    },
    // Feeds of items the viewer may not own (watched): look, don't touch.
    readOnly: {
        canCreateFolder: false,
        canUpload: false,
        canWrite: false,
        canDelete: false,
        canRename: false,
        canMove: false,
        canShare: false,
        showBreadcrumb: false,
        createTypes: new Set<EigenDocType>(),
    },
} as const satisfies Record<string, DriveCapabilities>;

// The fs browser follows the viewer's access to the folder: a read-only share still browses, but offers no writes.
export function browseCapabilities(canWrite: boolean): DriveCapabilities {
    return canWrite ? DRIVE_CAPABILITIES.browse : { ...DRIVE_CAPABILITIES.readOnly, showBreadcrumb: true };
}
