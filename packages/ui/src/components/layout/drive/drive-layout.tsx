import { getDriveDownloadUrl, openDocument } from '@workspace/lib/api';
import { usePaletteSelectionActions } from '@workspace/lib/command-palette';
import { useConvertDocument, useDeletePaths, useExportDocument, useMovePath } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useCallback, useMemo } from 'react';
import { Column, ColumnLayout } from '../app/column-layout.tsx';
import { useLayout } from '../app/layout-context.tsx';
import { LoadingState } from '../app/loading-state';
import { DriveAccessDialog } from './drive-access-dialog';
import { DriveCreateEigenDoc } from './drive-create-eigendoc';
import { DriveCreateFolder } from './drive-create-folder';
import { DriveDetail, DriveDetailToolbar } from './drive-detail';
import { DriveEmailCollaborators } from './drive-email-collaborators';
import { DriveList, DriveListToolbar } from './drive-list';
import { DriveRenameItem } from './drive-rename-item';
import { defaultDriveSort } from './drive-table';
import { DriveUploadFiles } from './drive-upload-files';
import { ExportProgressDialog } from './export-progress-dialog';
import { useDriveDialogs } from './use-drive-dialogs';

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
    allowCreateFolder?: boolean;
    allowDelete?: boolean;
    allowShare?: boolean;
    showBreadcrumb?: boolean;
    allowUpload?: boolean;
    allowCreateDoc?: boolean;
    allowCreateStickies?: boolean;
    allowCreateChat?: boolean;
    allowCreateSlides?: boolean;
    allowCreateSheets?: boolean;
    allowRename?: boolean;
    allowMove?: boolean;
    onQuickLook?: (path: DrivePath, sortedSiblings: DrivePath[]) => void;
    getItemHref?: (item: DrivePath) => string | undefined;
    sortFn?: (a: DrivePath, b: DrivePath) => number;
    pid?: string;
    unreadPathIds?: Set<string>;
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
    allowCreateFolder = true,
    allowDelete = true,
    allowShare = true,
    allowCreateDoc = true,
    allowCreateStickies = true,
    allowCreateChat = true,
    allowCreateSlides = true,
    allowCreateSheets = true,
    allowUpload = true,
    allowRename = true,
    allowMove = true,
    onQuickLook,
    getItemHref,
    sortFn = defaultDriveSort,
    pid = undefined,
    showBreadcrumb = false,
    unreadPathIds,
}: DriveLayoutProps) {
    const { isMobile } = useLayout();
    const dialogs = useDriveDialogs();
    const movePath = useMovePath(ownerId, mountId, currentPath?.id);
    const deletePathsMutation = useDeletePaths(ownerId, mountId);
    const convertMutation = useConvertDocument(ownerId, mountId);

    const handleFileUpload = () => {
        if (allowUpload && currentPath) {
            dialogs.upload.openDialog();
        }
    };

    const handleUploadFiles = (files: File[]) => {
        if (allowUpload && currentPath && files.length > 0) {
            dialogs.upload.openDialog(files);
        }
    };

    const handleDeletePaths = (paths: DrivePath[]) => {
        if (!allowDelete || paths.length === 0) return;
        deletePathsMutation.mutate(paths, {
            onSuccess: () => {
                for (const path of paths) onAfterAction?.('delete', path);
            },
        });
    };

    const handleRenamePath = (path: DrivePath) => {
        if (allowRename) {
            dialogs.rename.openDialog(path);
        }
    };

    const handleMovePath = async (path: DrivePath, targetItemId: string) => {
        if (!allowMove) return;
        await movePath.mutateAsync({ pathId: path.id, targetParentId: targetItemId });
    };

    const handleDownloadPath = (path: DrivePath) => {
        if (path?.type === 'file' && path.id) {
            const downloadUrl = getDriveDownloadUrl(path.ownerId, path.mountId, path.id);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = path.name || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    };

    const { exportDocument, isExporting } = useExportDocument();

    const handleExportPath = (path: DrivePath, format: string) =>
        exportDocument(path.ownerId, path.mountId, path.id, format);

    const handleConvertPath = (path: DrivePath, targetType: 'eigensheets' | 'eigendoc') => {
        if (!path.parentId) return;
        convertMutation.mutate(
            { pathId: path.id, targetType, parentId: path.parentId },
            {
                onSuccess: (newPath) => {
                    openDocument(newPath);
                },
            },
        );
    };

    const handleShareClick = (path: DrivePath) => {
        if (allowShare) {
            dialogs.share.openDialog(path);
        }
    };

    const handleEmailCollaborators = (path: DrivePath) => {
        if (allowShare) {
            dialogs.email.openDialog(path);
        }
    };

    const sortedContents = useMemo(() => [...folderContents].sort(sortFn), [folderContents, sortFn]);

    const wrappedQuickLook = useCallback(
        (path: DrivePath) => {
            onQuickLook?.(path, sortedContents);
        },
        [onQuickLook, sortedContents],
    );

    // Publish the same DriveItemMenuItems handlers to the palette so its selection-aware
    // commands (Rename, Share, Delete, Quick preview, Download, Email collaborators) hit
    // the same dialogs as right-clicking on a row.
    const paletteActions = useMemo(
        () => ({
            onQuickLook: onQuickLook ? wrappedQuickLook : undefined,
            onDownload: handleDownloadPath,
            onRename: allowRename ? handleRenamePath : undefined,
            onShare: allowShare ? handleShareClick : undefined,
            onEmailCollaborators: allowShare ? handleEmailCollaborators : undefined,
            onDelete: allowDelete ? handleDeletePaths : undefined,
        }),
        [onQuickLook, wrappedQuickLook, allowRename, allowShare, allowDelete],
    );
    usePaletteSelectionActions(paletteActions);

    if (isLoading) {
        return <LoadingState />;
    }

    const listProps = {
        items: folderContents,
        isLoading,
        error,
        onRowSelect,
        onRowActivate,
        activeRowId: pid,
        onCreateFolder: allowCreateFolder ? dialogs.createFolder.openDialog : undefined,
        onUploadFile: allowUpload ? handleFileUpload : undefined,
        onUploadFiles: allowUpload ? handleUploadFiles : undefined,
        onDelete: allowDelete ? handleDeletePaths : undefined,
        onShareClick: allowShare ? handleShareClick : undefined,
        onEmailCollaborators: allowShare ? handleEmailCollaborators : undefined,
        onCreateDoc: allowCreateDoc ? dialogs.createDoc.openDialog : undefined,
        onCreateStickies: allowCreateStickies ? dialogs.createStickies.openDialog : undefined,
        onCreateChat: allowCreateChat ? dialogs.createChat.openDialog : undefined,
        onCreateSlides: allowCreateSlides ? dialogs.createSlides.openDialog : undefined,
        onCreateSheets: allowCreateSheets ? dialogs.createSheets.openDialog : undefined,
        currentPath,
        ownerId,
        mountId,
        pathId,
        showBreadcrumb,
        onConvert: handleConvertPath,
        onDownload: handleDownloadPath,
        onExport: handleExportPath,
        getItemHref,
        allowDelete,
        allowUpload,
        onRename: allowRename ? handleRenamePath : undefined,
        onMove: allowMove ? handleMovePath : undefined,
        onQuickLook: onQuickLook ? wrappedQuickLook : undefined,
        sortFn,
        unreadPathIds,
    };

    const listToolbar = (
        <DriveListToolbar
            ownerId={ownerId}
            mountId={mountId}
            pathId={pathId}
            showBreadcrumb={showBreadcrumb}
            onRowActivate={onRowActivate}
            onCreateFolder={allowCreateFolder ? dialogs.createFolder.openDialog : undefined}
            onUploadFile={allowUpload ? handleFileUpload : undefined}
            onCreateDoc={allowCreateDoc ? dialogs.createDoc.openDialog : undefined}
            onCreateStickies={allowCreateStickies ? dialogs.createStickies.openDialog : undefined}
            onCreateChat={allowCreateChat ? dialogs.createChat.openDialog : undefined}
            onCreateSlides={allowCreateSlides ? dialogs.createSlides.openDialog : undefined}
            onCreateSheets={allowCreateSheets ? dialogs.createSheets.openDialog : undefined}
        />
    );

    // When `pid` is set the user is navigating to a specific file: don't fall
    // back to `currentPath` (the folder) during the brief refetch frame, or
    // the panel renders the folder's properties (with its Open button) for
    // one tick when arrow-keying between files.
    const detailPath = pid ? selectedPath : selectedPath || currentPath;

    const detailProps = {
        path: detailPath,
        onDelete: allowDelete ? handleDeletePaths : undefined,
        onShareClick: allowShare ? handleShareClick : undefined,
        onDownload: handleDownloadPath,
        onItemOpen: onRowActivate,
        allowDelete,
        onRename: allowRename ? handleRenamePath : undefined,
        onQuickLook: onQuickLook ? wrappedQuickLook : undefined,
        onConvert: handleConvertPath,
        onExport: handleExportPath,
        onEmailCollaborators: allowShare ? handleEmailCollaborators : undefined,
    };

    const mobileShowDetail = !!(selectedPath || (currentPath && currentPath?.type !== 'folder'));
    const pidInFolder = pid ? folderContents.some((p) => p.id === pid) : false;
    const desktopShowDetail = !!(pidInFolder || (currentPath && currentPath?.type !== 'folder'));
    const showDetail = isMobile ? mobileShowDetail : desktopShowDetail;

    const detailToolbar = showDetail && detailPath ? <DriveDetailToolbar onClose={onBackToList} /> : null;

    return (
        <>
            <ColumnLayout mobileColumn={mobileShowDetail ? 'detail' : 'list'}>
                <Column id="list" width="flex" toolbar={listToolbar}>
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

            {allowCreateFolder && (
                <DriveCreateFolder
                    open={dialogs.createFolder.open}
                    onOpenChange={dialogs.createFolder.setOpen}
                    defaultOwnerId={currentPath?.ownerId}
                    defaultFolderId={currentPath?.id}
                    defaultMountId={currentPath?.mountId}
                    onAfterCreate={(newPath) => onAfterAction?.('create', { name: newPath.name })}
                />
            )}

            {allowCreateDoc && (
                <DriveCreateEigenDoc
                    type="doc"
                    open={dialogs.createDoc.open}
                    onOpenChange={dialogs.createDoc.setOpen}
                    defaultOwnerId={currentPath?.ownerId}
                    defaultFolderId={currentPath?.id}
                    defaultMountId={currentPath?.mountId}
                />
            )}
            {allowCreateStickies && (
                <DriveCreateEigenDoc
                    type="stickies"
                    open={dialogs.createStickies.open}
                    onOpenChange={dialogs.createStickies.setOpen}
                    defaultOwnerId={currentPath?.ownerId}
                    defaultFolderId={currentPath?.id}
                    defaultMountId={currentPath?.mountId}
                />
            )}
            {allowCreateChat && (
                <DriveCreateEigenDoc
                    type="chat"
                    open={dialogs.createChat.open}
                    onOpenChange={dialogs.createChat.setOpen}
                    defaultOwnerId={currentPath?.ownerId}
                    defaultFolderId={currentPath?.id}
                    defaultMountId={currentPath?.mountId}
                />
            )}
            {allowCreateSlides && (
                <DriveCreateEigenDoc
                    type="slides"
                    open={dialogs.createSlides.open}
                    onOpenChange={dialogs.createSlides.setOpen}
                    defaultOwnerId={currentPath?.ownerId}
                    defaultFolderId={currentPath?.id}
                    defaultMountId={currentPath?.mountId}
                />
            )}
            {allowCreateSheets && (
                <DriveCreateEigenDoc
                    type="sheets"
                    open={dialogs.createSheets.open}
                    onOpenChange={dialogs.createSheets.setOpen}
                    defaultOwnerId={currentPath?.ownerId}
                    defaultFolderId={currentPath?.id}
                    defaultMountId={currentPath?.mountId}
                />
            )}

            {allowUpload && currentPath && (
                <DriveUploadFiles
                    path={currentPath}
                    open={dialogs.upload.open}
                    onOpenChange={dialogs.upload.setOpen}
                    initialFiles={dialogs.upload.files}
                    onAfterUpload={dialogs.upload.closeDialog}
                    onAfterAction={onAfterAction}
                />
            )}

            {allowRename && (
                <DriveRenameItem
                    path={dialogs.rename.item}
                    open={dialogs.rename.open}
                    onOpenChange={dialogs.rename.setOpen}
                    onAfterAction={onAfterAction}
                />
            )}

            {allowShare && (
                <DriveAccessDialog
                    open={dialogs.share.open}
                    onOpenChange={dialogs.share.setOpen}
                    path={dialogs.share.item}
                />
            )}

            {allowShare && dialogs.email.item && (
                <DriveEmailCollaborators
                    path={dialogs.email.item}
                    open={dialogs.email.open}
                    onOpenChange={(open) => {
                        if (!open) dialogs.email.closeDialog();
                        else dialogs.email.setOpen(open);
                    }}
                />
            )}

            <ExportProgressDialog open={isExporting} />
        </>
    );
}
