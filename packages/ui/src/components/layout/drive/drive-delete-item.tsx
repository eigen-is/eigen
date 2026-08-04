import { PartialDeleteError, useDeletePaths } from '@workspace/lib/drive';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { useEffect, useState } from 'react';

export type DriveDeleteItemProps = {
    paths: DrivePath[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export function DriveDeleteItem({ paths, open, onOpenChange, onAfterAction }: DriveDeleteItemProps) {
    const deletePathsMutation = useDeletePaths();
    // After a partial failure, retry only the paths that failed — re-trashing already-trashed ids 404s.
    // Cleared when the dialog closes so a fresh selection starts from the full list.
    const [failed, setFailed] = useState<DrivePath[] | null>(null);
    useEffect(() => {
        if (!open) setFailed(null);
    }, [open]);

    const targets = failed ?? paths;
    const first = targets[0] ?? null;
    const isSingle = targets.length === 1;

    const handleDelete = async () => {
        if (targets.length === 0) return;
        try {
            const succeeded = await deletePathsMutation.mutateAsync(targets);
            for (const path of succeeded) onAfterAction?.('delete', path);
        } catch (error) {
            if (error instanceof PartialDeleteError) {
                for (const path of error.succeeded) onAfterAction?.('delete', path);
                setFailed(error.failed);
            }
            throw error; // keep the dialog open for retry on the still-failed items
        }
    };

    const description = isSingle
        ? 'You can restore it later from the trash. Move'
        : `This will move ${targets.length} items to trash. You can restore them later from the trash.`;

    return (
        <DeleteDialog
            open={open}
            onOpenChange={onOpenChange}
            title={isSingle ? 'Move to trash' : `Move ${targets.length} items to trash`}
            description={description}
            itemName={isSingle && first ? stripEigenExtension(first.name) : undefined}
            onDelete={handleDelete}
            deleteText="Move to trash"
        />
    );
}
