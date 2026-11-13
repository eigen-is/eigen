// What a Drive view shows and lets the user do: the list or grid mode and the sort a user keeps in settings, the
// capabilities a view declares, such as upload or share, the search params a Drive URL carries, the folder a picker
// shows and the root path a Drive view's context provides. The Drive app and the shared Drive components read them.

import type { DrivePath, EigenDocType } from './drive';

export type DriveViewMode = 'list' | 'grid';
export const DRIVE_SORT_KEYS = ['name', 'modified', 'size'] as const;
export type DriveSortKey = (typeof DRIVE_SORT_KEYS)[number];
export type DriveSortDir = 'asc' | 'desc';
export type DriveSort = { key: DriveSortKey; dir: DriveSortDir };
export type DriveViewPreferences = { mode: DriveViewMode; sortKey: DriveSortKey; sortDir: DriveSortDir };

// What a Drive view lets the user do. Each view declares its whole set as one value, such as a preset
// spread with overrides, and every Drive action reads its gate from it.
export type DriveCapabilities = {
    canCreateFolder: boolean;
    canUpload: boolean;
    // May write where the listed items sit: a convert saves the new document beside its source.
    canWrite: boolean;
    canDelete: boolean;
    canRename: boolean;
    canMove: boolean;
    canShare: boolean;
    showBreadcrumb: boolean;
    // Omit to allow creating every EigenDocType; an empty set disables create entirely.
    createTypes?: ReadonlySet<EigenDocType>;
};

export type DriveSearchParams = {
    pid?: string;
    uid?: string;
    mid?: string;
    sharePathId?: string;
    shareEmail?: string;
};

// Where a Drive picker is: an empty folder id stands for the mount's root.
export type DriveLocationValue = { ownerId: string; mountId: string; folderId: string };

export type DriveContextType = {
    rootPath: DrivePath | null;
};
