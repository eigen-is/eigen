import { useDeletePaths } from '@workspace/lib/drive';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';

export type DriveDeleteItemProps = {
    paths: DrivePath[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export function DriveDeleteItem({ paths, open, onOpenChange, onAfterAction }: DriveDeleteItemProps) {
    const first = paths[0] ?? null;
    const isSingle = paths.length === 1;
    const deletePathsMutation = useDeletePaths();

    const handleDelete = () => {
        if (paths.length === 0) return;

        deletePathsMutation.mutate(paths, {
            onSuccess: () => {
                onOpenChange(false);
                for (const path of paths) onAfterAction?.('delete', path);
            },
        });
    };

    const description = isSingle
        ? 'You can restore it later from the trash. Move'
        : `This will move ${paths.length} items to trash. You can restore them later from the trash.`;

    return (
        <DeleteDialog
            open={open}
            onOpenChange={onOpenChange}
            title={isSingle ? 'Move to trash' : `Move ${paths.length} items to trash`}
            description={description}
            itemName={isSingle && first ? stripEigenExtension(first.name) : undefined}
            onDelete={handleDelete}
            deleteText="Move to trash"
        />
    );
}
