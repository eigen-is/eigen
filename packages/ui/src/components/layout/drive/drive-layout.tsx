import { getDriveDownloadUrl, openDocument } from '@workspace/lib/api';
import { usePaletteSelectionActions } from '@workspace/lib/command-palette';
import {
    getDriveComparator,
    useConvertDocument,
    useCopyPath,
    useDeletePaths,
    useDriveViewPreferences,
    useDuplicatePath,
    useExportDocument,
    useMovePath,
} from '@workspace/lib/drive';
import { useIsCoarsePointer } from '@workspace/lib/media';
import { type DrivePath, EIGEN_DOC_TYPES, type EigenDocType } from '@workspace/lib/types/drive';
import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Column, ColumnLayout } from '../app/column-layout.tsx';
import { useLayout } from '../app/layout-context.tsx';
import { LoadingState } from '../app/loading-state';
import { DriveAccessDialog } from './drive-access-dialog';
import { DriveCreateEigenDoc } from './drive-create-eigendoc';
import { DriveCreateFolder } from './drive-create-folder';
import { DriveDeleteItem } from './drive-delete-item';
import { DriveDetail, DriveDetailToolbar } from './drive-detail';
import { DriveEmailCollaborators } from './drive-email-collaborators';
import { DriveList, DriveListToolbar } from './drive-list';
import { DriveLocationPicker } from './drive-location-picker';
import { DriveRenameItem } from './drive-rename-item';
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
    // Toolbar title shown when there's no breadcrumb (filter/sharing/watched views).
    title?: string;
    allowUpload?: boolean;
    // Omit to allow every EigenDocType; pass an empty set to disable create entirely.
    allowedCreateTypes?: ReadonlySet<EigenDocType>;
    allowRename?: boolean;
    allowMove?: boolean;
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
    allowCreateFolder = true,
    allowDelete = true,
    allowShare = true,
    allowedCreateTypes,
    allowUpload = true,
    allowRename = true,
    allowMove = true,
    onQuickLook,
    getItemHref,
    pid = undefined,
    showBreadcrumb = false,
    title,
    unreadPathIds,
    emptyState,
    highlightHistory,
}: DriveLayoutProps) {
    const { isMobile } = useLayout();
    const dialogs = useDriveDialogs();
    const movePath = useMovePath(ownerId, mountId, currentPath?.id);
    const copyPath = useCopyPath();
    const duplicatePath = useDuplicatePath();
    const deletePathsMutation = useDeletePaths();
    const convertMutation = useConvertDocument(ownerId, mountId);
    const isCoarsePointer = useIsCoarsePointer();
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [pendingDeletePaths, setPendingDeletePaths] = useState<DrivePath[]>([]);

    // Sort order comes from the shared view preference.
    const { sortKey, sortDir } = useDriveViewPreferences();
    const activeSortFn = useMemo(() => getDriveComparator(sortKey, sortDir), [sortKey, sortDir]);

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

    // Memoized handlers below: stable identity is required because they're published
    // to the command palette via usePaletteSelectionActions, and that effect refires
    // whenever the action object's identity changes. Without memoization, the
    // useCommandPalette context subscription combined with each re-render of
    // DriveLayout produced an infinite setState loop.
    const runDeletePaths = useCallback(
        (paths: DrivePath[]) => {
            deletePathsMutation.mutate(paths, {
                onSuccess: () => {
                    for (const path of paths) onAfterAction?.('delete', path);
                },
            });
        },
        [deletePathsMutation, onAfterAction],
    );

    const handleDeletePaths = useCallback(
        (paths: DrivePath[]) => {
            if (!allowDelete || paths.length === 0) return;
            // Touch has no hover cue and mis-taps are easy, so confirm move-to-trash on coarse
            // pointers. Fine-pointer stays instant — byte-identical to before. Palette-triggered
            // deletes flow through here too, so they also confirm on touch (intended).
            if (isCoarsePointer) {
                setPendingDeletePaths(paths);
                setDeleteConfirmOpen(true);
                return;
            }
            runDeletePaths(paths);
        },
        [allowDelete, isCoarsePointer, runDeletePaths],
    );

    const handleRenamePath = useCallback(
        (path: DrivePath) => {
            if (allowRename) dialogs.rename.openDialog(path);
        },
        [allowRename, dialogs.rename.openDialog],
    );

    const handleMovePath = useCallback(
        async (path: DrivePath, targetItemId: string) => {
            if (!allowMove) return;
            await movePath.mutateAsync({ pathId: path.id, targetParentId: targetItemId });
        },
        [allowMove, movePath],
    );

    const handleMoveTo = useCallback(
        (items: DrivePath[]) => {
            if (items.length) dialogs.copyMove.openDialog(items, 'move');
        },
        [dialogs.copyMove.openDialog],
    );

    const handleCopyTo = useCallback(
        (items: DrivePath[]) => {
            if (items.length) dialogs.copyMove.openDialog(items, 'copy');
        },
        [dialogs.copyMove.openDialog],
    );

    const handleDuplicate = useCallback(
        (items: DrivePath[]) => {
            if (items.length) duplicatePath.mutate({ items });
        },
        [duplicatePath],
    );

    const handlePickDestination = useCallback(
        async (location: { ownerId: string; mountId: string; folderId: string }) => {
            const items = dialogs.copyMove.items;
            if (dialogs.copyMove.mode === 'move') {
                if (location.ownerId !== ownerId || location.mountId !== mountId) {
                    toast.error('Moving across drives isn’t supported yet — use Copy to…');
                    return;
                }
                await Promise.all(
                    items.map((item) => movePath.mutateAsync({ pathId: item.id, targetParentId: location.folderId })),
                );
            } else {
                await copyPath.mutateAsync({
                    items,
                    targetOwnerId: location.ownerId,
                    targetMountId: location.mountId,
                    targetParentId: location.folderId,
                });
            }
        },
        [dialogs.copyMove.items, dialogs.copyMove.mode, ownerId, mountId, movePath, copyPath],
    );

    const handleDownloadPath = useCallback((path: DrivePath) => {
        if (path?.type === 'file' && path.id) {
            const downloadUrl = getDriveDownloadUrl(path.ownerId, path.mountId, path.id, path.updatedAt);
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = path.name || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    }, []);

    const { exportDocument, isExporting } = useExportDocument();

    const handleExportPath = useCallback(
        (path: DrivePath, format: string) => exportDocument(path.ownerId, path.mountId, path.id, format),
        [exportDocument],
    );

    const handleConvertPath = useCallback(
        (path: DrivePath, targetType: 'eigensheets' | 'eigendoc') => {
            if (!path.parentId) return;
            convertMutation.mutate(
                { pathId: path.id, targetType, parentId: path.parentId },
                {
                    onSuccess: (newPath) => {
                        openDocument(newPath);
                    },
                },
            );
        },
        [convertMutation],
    );

    const handleShareClick = useCallback(
        (path: DrivePath) => {
            if (allowShare) dialogs.share.openDialog(path);
        },
        [allowShare, dialogs.share.openDialog],
    );

    const handleEmailCollaborators = useCallback(
        (path: DrivePath) => {
            if (allowShare) dialogs.email.openDialog(path);
        },
        [allowShare, dialogs.email.openDialog],
    );

    const sortedContents = useMemo(() => [...folderContents].sort(activeSortFn), [folderContents, activeSortFn]);

    const wrappedQuickLook = useCallback(
        (path: DrivePath) => {
            onQuickLook?.(path, sortedContents);
        },
        [onQuickLook, sortedContents],
    );

    // Publish the route-local dialog handlers to the palette. Quick preview is
    // intentionally omitted — it goes via CommandContext.openPreview (a global, from
    // the PreviewProvider that wraps the whole app), which keeps this object's
    // identity from churning when an inline onQuickLook prop changes each render.
    const paletteActions = useMemo(
        () => ({
            onDownload: handleDownloadPath,
            onRename: allowRename ? handleRenamePath : undefined,
            onShare: allowShare ? handleShareClick : undefined,
            onEmailCollaborators: allowShare ? handleEmailCollaborators : undefined,
            onDelete: allowDelete ? handleDeletePaths : undefined,
        }),
        [
            handleDownloadPath,
            handleRenamePath,
            handleShareClick,
            handleEmailCollaborators,
            handleDeletePaths,
            allowRename,
            allowShare,
            allowDelete,
        ],
    );
    usePaletteSelectionActions(paletteActions);

    if (isLoading) {
        return <LoadingState />;
    }

    const createTypes = allowedCreateTypes ?? new Set<EigenDocType>(EIGEN_DOC_TYPES);
    const onCreateEigenDoc: Partial<Record<EigenDocType, () => void>> = {};
    for (const type of EIGEN_DOC_TYPES) {
        if (createTypes.has(type)) onCreateEigenDoc[type] = dialogs.create[type].openDialog;
    }

    const listProps = {
        items: sortedContents,
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
        onCreateEigenDoc,
        ownerId,
        mountId,
        pathId,
        onConvert: handleConvertPath,
        onDownload: handleDownloadPath,
        onExport: handleExportPath,
        getItemHref,
        allowDelete,
        allowUpload,
        onRename: allowRename ? handleRenamePath : undefined,
        onMove: allowMove ? handleMovePath : undefined,
        onMoveTo: allowMove ? handleMoveTo : undefined,
        onCopyTo: handleCopyTo,
        onDuplicate: allowMove ? handleDuplicate : undefined,
        onQuickLook: onQuickLook ? wrappedQuickLook : undefined,
        unreadPathIds,
        emptyState,
    };

    const listToolbar = (
        <DriveListToolbar
            ownerId={ownerId}
            mountId={mountId}
            pathId={pathId}
            showBreadcrumb={showBreadcrumb}
            title={title}
            onRowActivate={onRowActivate}
            onCreateFolder={allowCreateFolder ? dialogs.createFolder.openDialog : undefined}
            onUploadFile={allowUpload ? handleFileUpload : undefined}
            onCreateEigenDoc={onCreateEigenDoc}
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
        onMoveTo: allowMove ? handleMoveTo : undefined,
        onCopyTo: handleCopyTo,
        onDuplicate: allowMove ? handleDuplicate : undefined,
        onQuickLook: onQuickLook ? wrappedQuickLook : undefined,
        onConvert: handleConvertPath,
        onExport: handleExportPath,
        onEmailCollaborators: allowShare ? handleEmailCollaborators : undefined,
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

            {EIGEN_DOC_TYPES.filter((type) => createTypes.has(type)).map((type) => (
                <DriveCreateEigenDoc
                    key={type}
                    type={type}
                    open={dialogs.create[type].open}
                    onOpenChange={dialogs.create[type].setOpen}
                    defaultOwnerId={currentPath?.ownerId}
                    defaultFolderId={currentPath?.id}
                    defaultMountId={currentPath?.mountId}
                />
            ))}

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

            <DriveLocationPicker
                open={dialogs.copyMove.open}
                onOpenChange={(open) => {
                    if (!open) dialogs.copyMove.closeDialog();
                    else dialogs.copyMove.setOpen(open);
                }}
                mode="folder"
                title={dialogs.copyMove.mode === 'move' ? 'Move to' : 'Copy to'}
                confirmLabel={dialogs.copyMove.mode === 'move' ? 'Move here' : 'Copy here'}
                defaultOwnerId={ownerId}
                defaultMountId={mountId}
                // currentPath can belong to another drive (eigendoc views pass the user's own
                // root while a teamdrive item is selected) — only seed it as the start folder
                // when it lives on the layout's drive, else fall back to that drive's root.
                defaultFolderId={
                    currentPath?.ownerId === ownerId && currentPath?.mountId === mountId ? currentPath?.id : undefined
                }
                onConfirm={handlePickDestination}
            />

            <DriveDeleteItem
                paths={pendingDeletePaths}
                open={deleteConfirmOpen}
                onOpenChange={(open) => {
                    setDeleteConfirmOpen(open);
                    if (!open) setPendingDeletePaths([]);
                }}
                onAfterAction={onAfterAction}
            />

            <ExportProgressDialog open={isExporting} />
        </>
    );
}
