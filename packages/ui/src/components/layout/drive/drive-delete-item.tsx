import {DEFAULT_MOUNT_ID, useDeleteFile, useDeleteFolder, useDeletePaths} from '@workspace/lib/drive';
import type {DrivePath} from '@workspace/lib/types/drive';
import {DeleteDialog} from '@workspace/ui/components/layout/delete/delete-dialog';

export type DriveDeleteItemProps = {
    paths: DrivePath[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export function DriveDeleteItem({paths, open, onOpenChange, onAfterAction}: DriveDeleteItemProps) {
    const first = paths[0] ?? null;
    const isSingle = paths.length === 1;
    const deleteFileMutation = useDeleteFile(
        first?.ownerId || '',
        first?.mountId || DEFAULT_MOUNT_ID,
        first?.parentId || undefined,
        first?.mimeType || undefined,
    );
    const deleteFolderMutation = useDeleteFolder(
        first?.ownerId || '',
        first?.mountId || DEFAULT_MOUNT_ID,
        first?.parentId || undefined,
        first?.mimeType || undefined,
    );
    const deletePathsMutation = useDeletePaths(first?.ownerId || '', first?.mountId || DEFAULT_MOUNT_ID);

    const handleDelete = () => {
        if (paths.length === 0) return;

        if (isSingle && first) {
            const mutation = first.type === 'folder' ? deleteFolderMutation : deleteFileMutation;
            mutation.mutate(first.id, {
                onSuccess: () => {
                    onOpenChange(false);
                    onAfterAction?.('delete', first);
                },
            });
        } else {
            deletePathsMutation.mutate(paths, {
                onSuccess: () => {
                    onOpenChange(false);
                    for (const path of paths) onAfterAction?.('delete', path);
                },
            });
        }
    };

    const description = isSingle
        ? 'Are you sure you want to delete'
        : `Are you sure you want to delete ${paths.length} items`;

    return (
        <DeleteDialog
            open={open}
            onOpenChange={onOpenChange}
            title={isSingle ? 'Delete Item' : `Delete ${paths.length} Items`}
            description={description}
            itemName={isSingle ? first?.name : undefined}
            onDelete={handleDelete}
        />
    );
}
