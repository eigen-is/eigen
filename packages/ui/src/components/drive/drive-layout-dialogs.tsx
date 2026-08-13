import { getDriveDownloadUrl, openDocument } from '@workspace/lib/api';
import { usePaletteSelectionActions } from '@workspace/lib/command-palette';
import { useConvertDocument, useCopyPath, useDeletePaths, useDuplicatePath, useMovePath } from '@workspace/lib/drive';
import { useIsCoarsePointer } from '@workspace/lib/media';
import { type DrivePath, EIGEN_DOC_TYPES, type EigenDocType } from '@workspace/lib/types/drive';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DriveAccessDialog } from './drive-access-dialog';
import type { DriveCapabilities } from './drive-capabilities';
import { DriveCreateEigenDoc } from './drive-create-eigendoc';
import { DriveCreateFolder } from './drive-create-folder';
import { DriveDeleteItem } from './drive-delete-item';
import { DriveEmailCollaborators } from './drive-email-collaborators';
import { DriveLocationPicker } from './drive-location-picker';
import { DriveRenameItem } from './drive-rename-item';
import { DriveUploadFiles } from './drive-upload-files';
import { ProgressDialog } from './progress-dialog';
import { ExportProgressDialog, useDocumentExport } from './use-document-export';
import { useDriveDialogs } from './use-drive-dialogs';

type UseDriveLayoutDialogsOptions = {
    ownerId: string;
    mountId: string;
    currentPath: DrivePath | null;
    capabilities: DriveCapabilities;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

// Owns every item action DriveLayout offers: the dialog state behind them, the
// mutations they run, and the palette publication. DriveLayout wires the on*
// handlers into its list/detail/toolbar; <DriveLayoutDialogs> renders the dialog
// stack from the same object. A capability that's off exposes `undefined`, so all
// surfaces hide the action the same way.
export function useDriveLayoutDialogs({
    ownerId,
    mountId,
    currentPath,
    capabilities,
    onAfterAction,
}: UseDriveLayoutDialogsOptions) {
    const dialogs = useDriveDialogs();
    const movePath = useMovePath(ownerId, mountId, currentPath?.id);
    const copyPath = useCopyPath();
    const duplicatePath = useDuplicatePath();
    const deletePathsMutation = useDeletePaths();
    const convertMutation = useConvertDocument(ownerId, mountId);
    const isCoarsePointer = useIsCoarsePointer();
    const { exportPath, isExporting } = useDocumentExport();
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [pendingDeletePaths, setPendingDeletePaths] = useState<DrivePath[]>([]);

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
            if (paths.length === 0) return;
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
        [isCoarsePointer, runDeletePaths],
    );

    const handleMovePath = useCallback(
        async (path: DrivePath, targetItemId: string) => {
            await movePath.mutateAsync({ pathId: path.id, targetParentId: targetItemId });
        },
        [movePath],
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

    const onDelete = capabilities.canDelete ? handleDeletePaths : undefined;
    const onRename = capabilities.canRename ? dialogs.rename.openDialog : undefined;
    const onShareClick = capabilities.canShare ? dialogs.share.openDialog : undefined;
    const onEmailCollaborators = capabilities.canShare ? dialogs.email.openDialog : undefined;

    // Publish the route-local dialog handlers to the palette. Quick preview is
    // intentionally omitted — it goes via CommandContext.openPreview (a global, from
    // the PreviewProvider that wraps the whole app), which keeps this object's
    // identity from churning when an inline onQuickLook prop changes each render.
    const paletteActions = useMemo(
        () => ({
            onDownload: handleDownloadPath,
            onRename,
            onShare: onShareClick,
            onEmailCollaborators,
            onDelete,
        }),
        [handleDownloadPath, onRename, onShareClick, onEmailCollaborators, onDelete],
    );
    usePaletteSelectionActions(paletteActions);

    const createTypes = capabilities.createTypes ?? new Set<EigenDocType>(EIGEN_DOC_TYPES);
    const onCreateEigenDoc: Partial<Record<EigenDocType, () => void>> = {};
    for (const type of EIGEN_DOC_TYPES) {
        if (createTypes.has(type)) onCreateEigenDoc[type] = dialogs.create[type].openDialog;
    }

    return {
        onCreateFolder: capabilities.canCreateFolder ? dialogs.createFolder.openDialog : undefined,
        onCreateEigenDoc,
        onUploadFile: capabilities.canUpload
            ? () => {
                  if (currentPath) dialogs.upload.openDialog();
              }
            : undefined,
        onUploadFiles: capabilities.canUpload
            ? (files: File[]) => {
                  if (currentPath && files.length > 0) dialogs.upload.openDialog(files);
              }
            : undefined,
        onDelete,
        onRename,
        onMove: capabilities.canMove ? handleMovePath : undefined,
        onMoveTo: capabilities.canMove ? handleMoveTo : undefined,
        onCopyTo: handleCopyTo,
        onDuplicate: capabilities.canMove ? handleDuplicate : undefined,
        onShareClick,
        onEmailCollaborators,
        onDownload: handleDownloadPath,
        onExport: exportPath,
        onConvert: handleConvertPath,
        // Wiring consumed by <DriveLayoutDialogs> below.
        ownerId,
        mountId,
        currentPath,
        capabilities,
        createTypes,
        onAfterAction,
        dialogs,
        pendingDeletePaths,
        deleteConfirmOpen,
        onDeleteConfirmOpenChange: (open: boolean) => {
            setDeleteConfirmOpen(open);
            if (!open) setPendingDeletePaths([]);
        },
        onPickDestination: handlePickDestination,
        isExporting,
        isConverting: convertMutation.isPending,
        convertTargetType: convertMutation.variables?.targetType,
    };
}

type DriveLayoutDialogsProps = {
    actions: ReturnType<typeof useDriveLayoutDialogs>;
};

export function DriveLayoutDialogs({ actions }: DriveLayoutDialogsProps) {
    const { ownerId, mountId, currentPath, capabilities, createTypes, onAfterAction, dialogs } = actions;

    return (
        <>
            {capabilities.canCreateFolder && (
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

            {capabilities.canUpload && currentPath && (
                <DriveUploadFiles
                    path={currentPath}
                    open={dialogs.upload.open}
                    onOpenChange={dialogs.upload.setOpen}
                    initialFiles={dialogs.upload.files}
                    onAfterUpload={dialogs.upload.closeDialog}
                    onAfterAction={onAfterAction}
                />
            )}

            {capabilities.canRename && (
                <DriveRenameItem
                    path={dialogs.rename.item}
                    open={dialogs.rename.open}
                    onOpenChange={dialogs.rename.setOpen}
                    onAfterAction={onAfterAction}
                />
            )}

            {capabilities.canShare && (
                <DriveAccessDialog
                    open={dialogs.share.open}
                    onOpenChange={dialogs.share.setOpen}
                    path={dialogs.share.item}
                />
            )}

            {capabilities.canShare && dialogs.email.item && (
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
                onConfirm={actions.onPickDestination}
            />

            <DriveDeleteItem
                paths={actions.pendingDeletePaths}
                open={actions.deleteConfirmOpen}
                onOpenChange={actions.onDeleteConfirmOpenChange}
                onAfterAction={onAfterAction}
            />

            <ExportProgressDialog open={actions.isExporting} />
            <ProgressDialog
                open={actions.isConverting}
                title={actions.convertTargetType === 'eigendoc' ? 'Converting to document' : 'Converting to sheet'}
            />
        </>
    );
}
