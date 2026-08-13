import type { EigenDocType } from '@workspace/lib/types/drive';

// What a DriveLayout view lets the user do. Each render site declares its whole
// capability set as one value — a preset below, optionally spread with overrides.
export type DriveCapabilities = {
    canCreateFolder: boolean;
    canUpload: boolean;
    canDelete: boolean;
    canRename: boolean;
    canMove: boolean;
    canShare: boolean;
    // The fs browser shows the folder breadcrumb; filtered views show a title instead.
    showBreadcrumb: boolean;
    // Omit to allow creating every EigenDocType; an empty set disables create entirely.
    createTypes?: ReadonlySet<EigenDocType>;
};

export const DRIVE_CAPABILITIES = {
    // The full folder browser (the fs route): create, upload, rearrange.
    browse: {
        canCreateFolder: true,
        canUpload: true,
        canDelete: true,
        canRename: true,
        canMove: true,
        canShare: true,
        showBreadcrumb: true,
    },
    // Flat views over existing items (mime filters, per-app doc lists): act on the
    // items, but no folder ops — move needs the folder context these views lack.
    listing: {
        canCreateFolder: false,
        canUpload: false,
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
        canDelete: false,
        canRename: false,
        canMove: false,
        canShare: false,
        showBreadcrumb: false,
        createTypes: new Set<EigenDocType>(),
    },
} as const satisfies Record<string, DriveCapabilities>;
