// The Drive action runner: performs a Drive action on a set of items, such as rename, move, share or
// delete, and owns the dialogs behind them. A layout such as DriveLayout builds one and hands it to its
// list, detail column and toolbar. Which rows apply comes from driveActionsFor, read through the view's
// capabilities: the item menu and the command palette draw those rows, and run refuses any other.

import { getDriveItemUrl, getDriveShareUrl, openMailComposeWith } from '@workspace/lib/api';
import { copyToClipboard } from '@workspace/lib/clipboard';
import {
    PartialBatchError,
    useCopyToFolder,
    useDeletePaths,
    useDriveActionsFor,
    useDuplicatePaths,
    useIsEffectiveOwnerOf,
    useMovePaths,
} from '@workspace/lib/drive';
import { useIsCoarsePointer } from '@workspace/lib/media';
import type { DriveCapabilities, DrivePath, EigenDocType, ExportFormat } from '@workspace/lib/types/drive';
import { EIGEN_DOC_TYPES } from '@workspace/lib/types/drive';
import type { DriveAction, DriveActionId } from '@workspace/lib/types/drive-actions';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { DriveAccessDialog } from './drive-access-dialog';
import { DriveCreateEigenDoc } from './drive-create-eigendoc';
import { DriveCreateFolder } from './drive-create-folder';
import { DriveDeleteItem } from './drive-delete-item';
import { DriveEmailCollaborators } from './drive-email-collaborators';
import { DriveLocationPicker } from './drive-location-picker';
import { DriveRenameItem } from './drive-rename-item';
import { ExportProgressDialog, useDocumentExport } from './use-document-export';
import { useDriveUploadFiles } from './use-drive-upload-files';

// The picker behind Move to and Copy to, with the items it was opened for.
type CopyMove = { items: readonly DrivePath[]; mode: 'move' | 'copy' };

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
    run: (id: DriveActionId, items: readonly DrivePath[], format?: ExportFormat) => void;
    // A drag onto a folder row, absent where the view can't move.
    onMove?: (path: DrivePath, targetItemId: string) => void;
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
    // One create dialog is open at a time, so the value says which.
    const createDialog = useDialogValue<EigenDocType | 'folder'>();
    const deleteDialog = useDialogValue<readonly DrivePath[]>();
    const renameDialog = useDialogValue<DrivePath>();
    const shareDialog = useDialogValue<DrivePath>();
    const emailDialog = useDialogValue<DrivePath>();
    const copyMoveDialog = useDialogValue<CopyMove>();
    const movePathsMutation = useMovePaths();
    const { mutateAsync: copyToFolder } = useCopyToFolder();
    const { mutate: duplicatePaths } = useDuplicatePaths();
    const deletePathsMutation = useDeletePaths();
    const isCoarsePointer = useIsCoarsePointer();
    const isEffectiveOwnerOf = useIsEffectiveOwnerOf();
    const actionsFor = useDriveActionsFor(capabilities);
    const { exportPath, isExporting } = useDocumentExport();
    const uploads = useDriveUploadFiles(currentPath, onAfterAction);

    const afterDelete = (deleted: readonly DrivePath[]) => {
        for (const path of deleted) onAfterAction?.('delete', path);
    };

    // A delete asks first on touch, where a tap can land on the wrong row, and for an item in someone else's
    // drive, where it leaves a direct share or trashes the owner's copy.
    const deletePaths = (paths: readonly DrivePath[]) => {
        if (isCoarsePointer || paths.some((path) => !isEffectiveOwnerOf(path.ownerId))) {
            deleteDialog.openDialog(paths);
            return;
        }
        deletePathsMutation.mutate(paths, {
            onSuccess: afterDelete,
            onError: (error) => {
                if (error instanceof PartialBatchError) afterDelete(error.succeeded);
            },
        });
    };

    const copyMove = copyMoveDialog.value;
    // A move never leaves its item's drive, so its picker starts there. A copy starts in the view's drive.
    const pickerDrive = copyMove?.mode === 'move' ? copyMove.items[0] : { ownerId, mountId };

    const handlePickDestination = async (
        { items, mode }: CopyMove,
        location: { ownerId: string; mountId: string; folderId: string },
    ) => {
        const leavesDrive = (item: DrivePath) => item.ownerId !== location.ownerId || item.mountId !== location.mountId;
        if (mode === 'move' && items.some(leavesDrive)) {
            toast.error('Moving across drives isn’t supported yet. Use Copy to… instead.');
            return;
        }
        const done =
            mode === 'move'
                ? movePathsMutation.mutateAsync({ paths: items, targetParentId: location.folderId })
                : copyToFolder({
                      items,
                      targetOwnerId: location.ownerId,
                      targetMountId: location.mountId,
                      targetParentId: location.folderId,
                  });
        await done.catch((error: unknown) => {
            if (error instanceof PartialBatchError) copyMoveDialog.openDialog({ items: error.failed, mode });
            throw error;
        });
    };

    const run = (id: DriveActionId, items: readonly DrivePath[], format?: ExportFormat) => {
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
                renameDialog.openDialog(item);
                return;
            case 'duplicate':
                duplicatePaths(items);
                return;
            case 'move-to':
                copyMoveDialog.openDialog({ items, mode: 'move' });
                return;
            case 'copy-to':
                copyMoveDialog.openDialog({ items, mode: 'copy' });
                return;
            case 'download-as':
                if (format) exportPath(item, format);
                return;
            case 'share':
                shareDialog.openDialog(item);
                return;
            case 'email-collaborators':
                emailDialog.openDialog(item);
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
        }
    };

    const createTypes = capabilities.createTypes ?? new Set<EigenDocType>(EIGEN_DOC_TYPES);
    const onCreateEigenDoc: Partial<Record<EigenDocType, () => void>> = {};
    for (const type of EIGEN_DOC_TYPES) {
        if (createTypes.has(type)) onCreateEigenDoc[type] = () => createDialog.openDialog(type);
    }

    return {
        capabilities,
        actionsFor,
        run,
        onMove: capabilities.canMove
            ? (path, targetItemId) => movePathsMutation.mutate({ paths: [path], targetParentId: targetItemId })
            : undefined,
        onCreateFolder: capabilities.canCreateFolder ? () => createDialog.openDialog('folder') : undefined,
        onCreateEigenDoc,
        onUploadFile: capabilities.canUpload ? uploads.pickFiles : undefined,
        onUploadFiles: capabilities.canUpload ? uploads.upload : undefined,
        dialogs: (
            <>
                {capabilities.canCreateFolder && (
                    <DriveCreateFolder
                        open={createDialog.open && createDialog.value === 'folder'}
                        onOpenChange={createDialog.setOpen}
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
                        open={createDialog.open && createDialog.value === type}
                        onOpenChange={createDialog.setOpen}
                        defaultOwnerId={currentPath?.ownerId}
                        defaultFolderId={currentPath?.id}
                        defaultMountId={currentPath?.mountId}
                    />
                ))}

                {capabilities.canUpload && currentPath && uploads.input}

                {renameDialog.value && (
                    <DriveRenameItem
                        path={renameDialog.value}
                        open={renameDialog.open}
                        onOpenChange={renameDialog.setOpen}
                        onAfterAction={onAfterAction}
                    />
                )}

                {shareDialog.value && (
                    <DriveAccessDialog
                        path={shareDialog.value}
                        open={shareDialog.open}
                        onOpenChange={shareDialog.setOpen}
                    />
                )}

                {emailDialog.value && (
                    <DriveEmailCollaborators
                        path={emailDialog.value}
                        open={emailDialog.open}
                        onOpenChange={emailDialog.setOpen}
                    />
                )}

                {copyMove && (
                    <DriveLocationPicker
                        open={copyMoveDialog.open}
                        onOpenChange={copyMoveDialog.setOpen}
                        mode="folder"
                        title={copyMove.mode === 'move' ? 'Move to' : 'Copy to'}
                        confirmLabel={copyMove.mode === 'move' ? 'Move here' : 'Copy here'}
                        defaultOwnerId={pickerDrive.ownerId}
                        defaultMountId={pickerDrive.mountId}
                        // The view's folder can sit on another drive than the picker's. Then it starts at the root.
                        defaultFolderId={
                            currentPath?.ownerId === pickerDrive.ownerId && currentPath.mountId === pickerDrive.mountId
                                ? currentPath.id
                                : undefined
                        }
                        onConfirm={(location) => handlePickDestination(copyMove, location)}
                    />
                )}

                {deleteDialog.value && (
                    <DriveDeleteItem
                        paths={deleteDialog.value}
                        open={deleteDialog.open}
                        onOpenChange={deleteDialog.setOpen}
                        onAfterAction={onAfterAction}
                        onPartialFailure={deleteDialog.openDialog}
                    />
                )}

                <ExportProgressDialog open={isExporting} />
            </>
        ),
    };
}
