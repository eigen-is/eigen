import { getDriveComparator, useDriveViewPreferences } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type React from 'react';
import { useCallback, useMemo } from 'react';
import { Column, ColumnLayout } from '../layout/app/column-layout';
import { useLayout } from '../layout/app/layout-context';
import { LoadingState } from '../layout/app/loading-state';
import type { DriveCapabilities } from './drive-capabilities';
import { DriveDetail, DriveDetailToolbar } from './drive-detail';
import { DriveLayoutDialogs, useDriveLayoutDialogs } from './drive-layout-dialogs';
import { DriveList, DriveListToolbar } from './drive-list';

export type DriveLayoutProps = {
    ownerId: string;
    mountId: string;
    pathId?: string;
    folderContents: DrivePath[];
    isLoading: boolean;
    error: Error | null;
    selectedPath?: DrivePath | null;
    currentPath?: DrivePath | null;
    onRowSelect: (path: DrivePath) => void;
    onRowActivate?: (path: DrivePath) => void;
    onBackToList: () => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
    capabilities: DriveCapabilities;
    // Toolbar title shown when there's no breadcrumb (filter/sharing/watched views).
    title?: string;
    onQuickLook?: (path: DrivePath, sortedSiblings: DrivePath[]) => void;
    getItemHref?: (item: DrivePath) => string | undefined;
    pid?: string;
    unreadPathIds?: Set<string>;
    emptyState?: React.ReactNode;
    highlightHistory?: boolean;
};

export function DriveLayout({
    ownerId,
    mountId,
    folderContents,
    isLoading,
    error,
    onRowSelect,
    onRowActivate,
    onBackToList,
    onAfterAction,
    pathId,
    selectedPath = null,
    currentPath = null,
    capabilities,
    onQuickLook,
    getItemHref,
    pid = undefined,
    title,
    unreadPathIds,
    emptyState,
    highlightHistory,
}: DriveLayoutProps) {
    const { isMobile } = useLayout();
    const actions = useDriveLayoutDialogs({ ownerId, mountId, currentPath, capabilities, onAfterAction });

    // Sort order comes from the shared view preference.
    const { sortKey, sortDir } = useDriveViewPreferences();
    const activeSortFn = useMemo(() => getDriveComparator(sortKey, sortDir), [sortKey, sortDir]);
    const sortedContents = useMemo(() => [...folderContents].sort(activeSortFn), [folderContents, activeSortFn]);

    const wrappedQuickLook = useCallback(
        (path: DrivePath) => {
            onQuickLook?.(path, sortedContents);
        },
        [onQuickLook, sortedContents],
    );

    if (isLoading) {
        return <LoadingState />;
    }

    const listProps = {
        items: sortedContents,
        isLoading,
        error,
        onRowSelect,
        onRowActivate,
        activeRowId: pid,
        onCreateFolder: actions.onCreateFolder,
        onUploadFile: actions.onUploadFile,
        onUploadFiles: actions.onUploadFiles,
        onDelete: actions.onDelete,
        onShareClick: actions.onShareClick,
        onEmailCollaborators: actions.onEmailCollaborators,
        onCreateEigenDoc: actions.onCreateEigenDoc,
        ownerId,
        mountId,
        pathId,
        onConvert: actions.onConvert,
        onDownload: actions.onDownload,
        onExport: actions.onExport,
        getItemHref,
        allowDelete: capabilities.canDelete,
        allowUpload: capabilities.canUpload,
        onRename: actions.onRename,
        onMove: actions.onMove,
        onMoveTo: actions.onMoveTo,
        onCopyTo: actions.onCopyTo,
        onDuplicate: actions.onDuplicate,
        onQuickLook: onQuickLook ? wrappedQuickLook : undefined,
        unreadPathIds,
        emptyState,
    };

    const listToolbar = (
        <DriveListToolbar
            ownerId={ownerId}
            mountId={mountId}
            pathId={pathId}
            showBreadcrumb={capabilities.showBreadcrumb}
            title={title}
            onRowActivate={onRowActivate}
            onCreateFolder={actions.onCreateFolder}
            onUploadFile={actions.onUploadFile}
            onCreateEigenDoc={actions.onCreateEigenDoc}
        />
    );

    // When `pid` is set the user is navigating to a specific file: don't fall
    // back to `currentPath` (the folder) during the brief refetch frame, or
    // the panel renders the folder's properties (with its Open button) for
    // one tick when arrow-keying between files.
    const detailPath = pid ? selectedPath : selectedPath || currentPath;

    const detailProps = {
        path: detailPath,
        onDelete: actions.onDelete,
        onShareClick: actions.onShareClick,
        onDownload: actions.onDownload,
        onItemOpen: onRowActivate,
        allowDelete: capabilities.canDelete,
        onRename: actions.onRename,
        onMoveTo: actions.onMoveTo,
        onCopyTo: actions.onCopyTo,
        onDuplicate: actions.onDuplicate,
        onQuickLook: onQuickLook ? wrappedQuickLook : undefined,
        onConvert: actions.onConvert,
        onExport: actions.onExport,
        onEmailCollaborators: actions.onEmailCollaborators,
        highlightHistory,
    };

    const mobileShowDetail = !!(selectedPath || (currentPath && currentPath?.type !== 'folder'));
    const pidInFolder = pid ? folderContents.some((p) => p.id === pid) : false;
    const desktopShowDetail = !!(pidInFolder || (currentPath && currentPath?.type !== 'folder'));
    const showDetail = isMobile ? mobileShowDetail : desktopShowDetail;

    const detailToolbar = showDetail && detailPath ? <DriveDetailToolbar onClose={onBackToList} /> : null;

    return (
        <>
            <ColumnLayout mobileColumn={mobileShowDetail ? 'detail' : 'list'}>
                <Column id="list" width="flex" onBack="sidebar" toolbar={listToolbar}>
                    <DriveList {...listProps} />
                </Column>
                {showDetail && (
                    <Column
                        id="detail"
                        width={isMobile ? 'flex' : '400px'}
                        onBack={onBackToList}
                        toolbar={detailToolbar}
                    >
                        <DriveDetail {...detailProps} />
                    </Column>
                )}
            </ColumnLayout>

            <DriveLayoutDialogs actions={actions} />
        </>
    );
}
