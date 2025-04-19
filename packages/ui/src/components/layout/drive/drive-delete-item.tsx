import {toast} from "sonner";
import {DrivePath} from "@apps/api-server/types/drive";
import {useDeleteFile, useDeleteFolder, useInvalidateFolder} from "@workspace/lib/drive";
import {DeleteDialog} from "@workspace/ui/components/layout/delete/delete-dialog";
import {useQueryClient} from "@tanstack/react-query";
import {invalidateHomeSize} from "@workspace/lib/home";

export interface DriveDeleteItemProps {
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
    const queryClient = useQueryClient();
    const deleteFileMutation = useDeleteFile(path?.ownerId || '');
    const deleteFolderMutation = useDeleteFolder(path?.ownerId || '');
    const invalidateFolder = useInvalidateFolder();

    const handleDelete = () => {
        if (!path) return;

        // Use the appropriate mutation based on item type
        const mutation = path.type !== 'file' ? deleteFolderMutation : deleteFileMutation;

        mutation.mutate(path.id, {
            onSuccess: () => {
                toast.success(`${path.type === 'folder' ? 'Folder' : 'File'} deleted successfully`);
                onOpenChange(false);

                // Invalidate queries to refresh folder contents
                invalidateFolder(path.parentId || '');
                invalidateHomeSize(queryClient);

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
