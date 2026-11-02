// The Drive action runner: performs a Drive action on a set of items, such as rename, move, share or
// delete, and owns the dialogs behind them. DriveLayout builds one and hands it to the list, the detail
// column and the toolbar. Which rows a surface draws comes from driveActionsFor, read through the
// view's capabilities, so every surface and the command palette offer the same set.

import { getDriveItemUrl, getDriveShareUrl, openMailComposeWith } from '@workspace/lib/api';
import { useIsGuest } from '@workspace/lib/auth';
import { copyToClipboard } from '@workspace/lib/clipboard';
import { usePaletteSelectionActions } from '@workspace/lib/command-palette';
import { downloadDriveFile } from '@workspace/lib/download';
import {
    driveActionsFor,
    useCopyPath,
    useDeletePaths,
    useDuplicatePath,
    useIsEffectiveOwnerOf,
    useIsSharedWithMe,
    useMovePath,
} from '@workspace/lib/drive';
import { useIsCoarsePointer } from '@workspace/lib/media';
import { useMailEnabled } from '@workspace/lib/public';
import type {
    DriveAction,
    DriveActionId,
    DriveCapabilities,
    DrivePath,
    EigenDocType,
    ExportFormat,
} from '@workspace/lib/types/drive';
import { EIGEN_DOC_TYPES } from '@workspace/lib/types/drive';
import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { DriveAccessDialog } from './drive-access-dialog';
import { DriveCreateEigenDoc } from './drive-create-eigendoc';
import { DriveCreateFolder } from './drive-create-folder';
import { DriveDeleteItem } from './drive-delete-item';
import { DriveEmailCollaborators } from './drive-email-collaborators';
import { DriveLocationPicker } from './drive-location-picker';
import { DriveRenameItem } from './drive-rename-item';
import { DriveUploadFiles } from './drive-upload-files';
import { ExportProgressDialog, useDocumentExport } from './use-document-export';
import { useDriveDialogs } from './use-drive-dialogs';

type UseDriveActionRunnerOptions = {
    ownerId: string;
    mountId: string;
    currentPath: DrivePath | null;
    capabilities: DriveCapabilities;
    // What Open does with an item: a folder opens in the view, a document in its app.
    onOpen: (path: DrivePath) => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export type DriveActionRunner = {
    capabilities: DriveCapabilities;
    // The rows these items offer in this view, to this viewer, on this server.
    actionsFor: (items: readonly DrivePath[]) => DriveAction[];
    // Does nothing for a row the items don't offer. Download as… names its format.
    run: (id: DriveActionId, items: DrivePath[], format?: ExportFormat) => void;
    // A drag onto a folder row, absent where the view can't move.
    onMove?: (path: DrivePath, targetItemId: string) => Promise<void>;
    onCreateFolder?: () => void;
    onCreateEigenDoc: Partial<Record<EigenDocType, () => void>>;
    onUploadFile?: () => void;
    onUploadFiles?: (files: File[]) => void;
    // Rendered once by DriveLayout, so a dialog opened from a menu row outlives the menu that closed.
    dialogs: ReactNode;
};

export function useDriveActionRunner({
    ownerId,
    mountId,
    currentPath,
    capabilities,
    onOpen,
    onAfterAction,
}: UseDriveActionRunnerOptions): DriveActionRunner {
    const dialogs = useDriveDialogs();
    const movePath = useMovePath(ownerId, mountId, currentPath?.id);
    const copyPath = useCopyPath();
    const duplicatePath = useDuplicatePath();
    const deletePathsMutation = useDeletePaths();
    const isCoarsePointer = useIsCoarsePointer();
    const isEffectiveOwnerOf = useIsEffectiveOwnerOf();
    const isSharedWithMe = useIsSharedWithMe();
    const isGuest = useIsGuest();
    const mailEnabled = useMailEnabled();
    const { exportPath, isExporting } = useDocumentExport();

    // The one place that knows who is asking and whether mail is hosted, as useFileActions is for file actions.
    const actionsFor = (items: readonly DrivePath[]) =>
        driveActionsFor({ items, capabilities, sharedWithMe: items.every(isSharedWithMe) }).filter(
            (action) => !(isGuest && action.guestDenied) && (mailEnabled || !action.mailOnly),
        );

    const deletePaths = (paths: DrivePath[]) => {
        if (paths.length === 0) return;
        // Confirm on touch (no hover cue, easy mis-taps) and for paths in someone else's drive, where
        // "delete" either leaves a direct share or trashes the owner's copy. Fine-pointer own-drive
        // deletes stay instant.
        if (isCoarsePointer || paths.some((path) => !isEffectiveOwnerOf(path.ownerId))) {
            dialogs.delete.openDialog(paths);
            return;
        }
        deletePathsMutation.mutate(paths, {
            onSuccess: () => {
                for (const path of paths) onAfterAction?.('delete', path);
            },
        });
    };

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

    const run = (id: DriveActionId, items: DrivePath[], format?: ExportFormat) => {
        if (!actionsFor(items).some((action) => action.id === id)) return;
        const [item] = items;
        switch (id) {
            case 'open':
                onOpen(item);
                return;
            case 'open-new-tab': {
                const href = getDriveItemUrl(item);
                if (href) window.open(href, '_blank', 'noopener,noreferrer');
                return;
            }
            case 'rename':
                dialogs.rename.openDialog(item);
                return;
            case 'duplicate':
                handleDuplicate(items);
                return;
            case 'move-to':
                dialogs.copyMove.openDialog(items, 'move');
                return;
            case 'copy-to':
                dialogs.copyMove.openDialog(items, 'copy');
                return;
            case 'download-as':
                if (format) exportPath(item, format);
                return;
            case 'share':
                dialogs.share.openDialog(item);
                return;
            case 'email-collaborators':
                dialogs.email.openDialog(item);
                return;
            case 'copy-link':
                copyToClipboard(getDriveShareUrl(item), 'Link copied to clipboard');
                return;
            case 'mail-to':
                openMailComposeWith({ attachments: items });
                return;
            case 'trash':
            case 'remove-shared':
                deletePaths(items);
                return;
            // Watch toggles through WatchMenuItem, whose label follows the item's live watch state.
        }
    };

    // The command palette acts on the selection the list publishes, through the same dialogs.
    usePaletteSelectionActions({
        onDownload: (path) => {
            if (path.type === 'file') downloadDriveFile(path);
        },
        onExport: exportPath,
        onRename: capabilities.canRename ? dialogs.rename.openDialog : undefined,
        onShare: capabilities.canShare ? dialogs.share.openDialog : undefined,
        // A guest may not mail people through the server, as a guest may not share.
        onEmailCollaborators: capabilities.canShare && !isGuest ? dialogs.email.openDialog : undefined,
        onDelete: capabilities.canDelete ? deletePaths : undefined,
    });

    const createTypes = capabilities.createTypes ?? new Set<EigenDocType>(EIGEN_DOC_TYPES);
    const onCreateEigenDoc: Partial<Record<EigenDocType, () => void>> = {};
    for (const type of EIGEN_DOC_TYPES) {
        if (createTypes.has(type)) onCreateEigenDoc[type] = dialogs.create[type].openDialog;
    }

    return {
        capabilities,
        actionsFor,
        run,
        onMove: capabilities.canMove
            ? async (path, targetItemId) => {
                  await movePath.mutateAsync({ pathId: path.id, targetParentId: targetItemId });
              }
            : undefined,
        onCreateFolder: capabilities.canCreateFolder ? dialogs.createFolder.openDialog : undefined,
        onCreateEigenDoc,
        onUploadFile: capabilities.canUpload
            ? () => {
                  if (currentPath) dialogs.upload.openDialog();
              }
            : undefined,
        onUploadFiles: capabilities.canUpload
            ? (files) => {
                  if (currentPath && files.length > 0) dialogs.upload.openDialog(files);
              }
            : undefined,
        dialogs: (
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

                {dialogs.rename.item && (
                    <DriveRenameItem
                        path={dialogs.rename.item}
                        open={dialogs.rename.open}
                        onOpenChange={dialogs.rename.setOpen}
                        onAfterAction={onAfterAction}
                    />
                )}

                <DriveAccessDialog
                    open={dialogs.share.open}
                    onOpenChange={dialogs.share.setOpen}
                    path={dialogs.share.item}
                />

                {dialogs.email.item && (
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
                    // currentPath can belong to another drive (eigendoc views pass the user's own root while a
                    // team drive item is selected). It seeds the start folder only when it lives on the layout's
                    // drive; otherwise the picker starts at that drive's root.
                    defaultFolderId={
                        currentPath?.ownerId === ownerId && currentPath?.mountId === mountId
                            ? currentPath?.id
                            : undefined
                    }
                    onConfirm={handlePickDestination}
                />

                <DriveDeleteItem
                    paths={dialogs.delete.items}
                    open={dialogs.delete.open}
                    onOpenChange={(open) => {
                        if (!open) dialogs.delete.closeDialog();
                        else dialogs.delete.setOpen(open);
                    }}
                    onAfterAction={onAfterAction}
                />

                <ExportProgressDialog open={isExporting} />
            </>
        ),
    };
}
