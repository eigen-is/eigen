// The list-and-detail page every Drive listing shares, such as a folder, Shared with me or a filter by
// type: the sorted rows with their toolbar, the selected item's detail beside them, and the dialogs
// their actions open. The caller fetches the rows and says through its capabilities what the viewer
// may do; this lays them out and wires the actions.

import { getDriveItemUrl } from '@workspace/lib/api';
import { getDriveComparator } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveCapabilities } from '@workspace/lib/types/drive-view';
import { useCallback, useMemo } from 'react';
import { Column, ColumnLayout } from '../layout/app/column-layout';
import { useLayout } from '../layout/app/layout-context';
import { LoadingState } from '../layout/app/loading-state';
import { useDriveActionRunner } from './drive-action-runner';
import { DriveDetail, DriveDetailToolbar } from './drive-detail';
import { DriveList, DriveListToolbar } from './drive-list';
import type { DriveListDate, DriveSortControl } from './drive-table';
import { useDriveSort } from './drive-table';

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
    onRowActivate: (path: DrivePath) => void;
    onOpenSharedWithMe?: () => void;
    onBackToList: () => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
    capabilities: DriveCapabilities;
    // The toolbar's title where there is no breadcrumb, such as in a filter by type or the watched feed.
    title?: string;
    onQuickLook?: (path: DrivePath, sortedSiblings: DrivePath[]) => void;
    pid?: string;
    unreadPathIds?: ReadonlySet<string>;
    sort?: DriveSortControl;
    date?: DriveListDate;
};

export function DriveLayout({
    ownerId,
    mountId,
    folderContents,
    isLoading,
    error,
    onRowSelect,
    onRowActivate,
    onOpenSharedWithMe,
    onBackToList,
    onAfterAction,
    pathId,
    selectedPath = null,
    currentPath = null,
    capabilities,
    onQuickLook,
    pid,
    title,
    unreadPathIds,
    sort,
    date,
}: DriveLayoutProps) {
    const { isMobile } = useLayout();
    const actions = useDriveActionRunner({
        ownerId,
        mountId,
        currentPath,
        capabilities,
        onOpen: onRowActivate,
        onAfterAction,
    });

    const { key: sortKey, dir: sortDir } = useDriveSort(sort);
    const activeSortFn = useMemo(
        () => getDriveComparator(sortKey, sortDir, (path) => date?.of(path) ?? path.updatedAt),
        [sortKey, sortDir, date],
    );
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
        error,
        onRowSelect,
        onRowActivate,
        activeRowId: pid,
        onCreateFolder: actions.onCreateFolder,
        onUploadFile: actions.onUploadFile,
        onUploadFiles: actions.onUploadFiles,
        onCreateEigenDoc: actions.onCreateEigenDoc,
        ownerId,
        mountId,
        pathId,
        // Every view links rows to the one canonical item URL.
        getItemHref: getDriveItemUrl,
        allowUpload: capabilities.canUpload,
        actions,
        onQuickLook: onQuickLook ? wrappedQuickLook : undefined,
        unreadPathIds,
        sort,
        date,
    };

    const listToolbar = (
        <DriveListToolbar
            ownerId={ownerId}
            mountId={mountId}
            pathId={pathId}
            showBreadcrumb={capabilities.showBreadcrumb}
            title={title}
            onRowActivate={onRowActivate}
            onOpenSharedWithMe={onOpenSharedWithMe}
            onCreateFolder={actions.onCreateFolder}
            onUploadFile={actions.onUploadFile}
            onCreateEigenDoc={actions.onCreateEigenDoc}
            sort={sort}
            dateLabel={date?.label}
        />
    );

    // A pid in the URL means the user is on one file. Falling back to the folder while that file
    // refetches would draw the folder's details, Open button included, for a moment on every arrow key.
    const detailPath = pid ? selectedPath : selectedPath || currentPath;

    const mobileShowDetail = !!(selectedPath || (currentPath && currentPath.type !== 'folder'));
    // A file moved out of a folder keeps its pid in the URL, so a folder shows only its own rows' detail. A
    // feed without a folder shows any pid it resolves, since a share link can land on an item it doesn't list.
    const pidInFolder = pid ? folderContents.some((p) => p.id === pid) : false;
    const desktopShowDetail = !!(
        pidInFolder ||
        (!currentPath && selectedPath) ||
        (currentPath && currentPath.type !== 'folder')
    );
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
                        <DriveDetail path={detailPath} siblings={sortedContents} actions={actions} />
                    </Column>
                )}
            </ColumnLayout>

            {actions.dialogs}
        </>
    );
}
