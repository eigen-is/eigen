import {toast} from "sonner";
import type {DrivePath} from "@workspace/lib/types/drive";
import {useDeleteFile, useDeleteFolder} from "@workspace/lib/drive";
import {DeleteDialog} from "@workspace/ui/components/layout/delete/delete-dialog";

export type DriveDeleteItemProps = {
    path: DrivePath | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAfterAction?: (actionType: string, data: any) => void;
}

export function DriveDeleteItem({
                                    path,
                                    open,
                                    onOpenChange,
                                    onAfterAction,
                                }: DriveDeleteItemProps) {
    const deleteFileMutation = useDeleteFile(path?.ownerId || '');
    const deleteFolderMutation = useDeleteFolder(path?.ownerId || '');

    const handleDelete = () => {
        if (!path) return;

        // Use the appropriate mutation based on item type
        const mutation = path.type !== 'file' ? deleteFolderMutation : deleteFileMutation;

        mutation.mutate(path.id, {
            onSuccess: () => {
                onOpenChange(false);

                if (onAfterAction) {
                    onAfterAction('delete', path);
                }
            },
            onError: () => {
                toast.error(`Failed to delete ${path.type}`);
            }
        });
    };

    return (
        <DeleteDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Delete Item"
            description="Are you sure you want to delete"
            itemName={path?.name}
            onDelete={handleDelete}
        />
    );
}
