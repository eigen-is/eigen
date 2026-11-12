// The Drive action runner: performs a Drive action on a set of items, such as rename, move, share or
// delete, and owns the dialogs behind them. DriveLayout builds one and hands it to the list, the detail
// column and the toolbar. Which rows apply comes from driveActionsFor, read through the view's
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
import type { ReactNode } from 'react';
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
    run: (id: DriveActionId, items: readonly DrivePath[], format?: ExportFormat) => void;
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
    const { mutateAsync: movePaths } = useMovePaths();
    const { mutateAsync: copyToFolder } = useCopyToFolder();
    const { mutate: duplicatePaths } = useDuplicatePaths();
    const deletePathsMutation = useDeletePaths();
    const isCoarsePointer = useIsCoarsePointer();
    const isEffectiveOwnerOf = useIsEffectiveOwnerOf();
    const actionsFor = useDriveActionsFor(capabilities);
    const { exportPath, isExporting } = useDocumentExport();

    // A delete asks first on touch, where a tap can land on the wrong row, and for an item in someone else's
    // drive, where it leaves a direct share or trashes the owner's copy.
    const deletePaths = (paths: readonly DrivePath[]) => {
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

    const handlePickDestination = async (location: { ownerId: string; mountId: string; folderId: string }) => {
        const { items, mode } = dialogs.copyMove;
        const leavesDrive = (item: DrivePath) => item.ownerId !== location.ownerId || item.mountId !== location.mountId;
        if (mode === 'move' && items.some(leavesDrive)) {
            toast.error('Moving across drives isn’t supported yet. Use Copy to… instead.');
            return;
        }
        const done =
            mode === 'move'
                ? movePaths({ paths: items, targetParentId: location.folderId })
                : copyToFolder({
                      items,
                      targetOwnerId: location.ownerId,
                      targetMountId: location.mountId,
                      targetParentId: location.folderId,
                  });
        await done.catch((error: unknown) => {
            if (error instanceof PartialBatchError) dialogs.copyMove.openDialog(error.failed, mode);
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
                dialogs.rename.openDialog(item);
                return;
            case 'duplicate':
                duplicatePaths(items);
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
        }
    };

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
                  await movePaths({ paths: [path], targetParentId: targetItemId });
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
                    // currentPath can sit on another drive, as a document app's index passes the viewer's own root
                    // while a team drive item is selected. Then the picker starts at the layout drive's root.
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
