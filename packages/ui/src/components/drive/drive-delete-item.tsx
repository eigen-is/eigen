import { PartialDeleteError, useDeletePaths, useIsEffectiveOwnerOf, useIsSharedWithMe } from '@workspace/lib/drive';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import { DeleteDialog } from '@workspace/ui/components/delete/delete-dialog';
import { useEffect, useState } from 'react';

export type DriveDeleteItemProps = {
    paths: DrivePath[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export function DriveDeleteItem({ paths, open, onOpenChange, onAfterAction }: DriveDeleteItemProps) {
    const deletePathsMutation = useDeletePaths();
    const isSharedWithMe = useIsSharedWithMe();
    const isEffectiveOwnerOf = useIsEffectiveOwnerOf();
    // After a partial failure, retry only the paths that failed — re-trashing already-trashed ids 404s.
    // Cleared when the dialog closes so a fresh selection starts from the full list.
    const [failed, setFailed] = useState<DrivePath[] | null>(null);
    useEffect(() => {
        if (!open) setFailed(null);
    }, [open]);

    const targets = failed ?? paths;
    const first = targets[0] ?? null;
    const isSingle = targets.length === 1;
    // The server leaves a direct share instead of trashing it, and trashes a path in someone
    // else's drive into their trash; the copy says which.
    const leaving = targets.filter(isSharedWithMe).length;
    const foreign = targets.some((path) => !isEffectiveOwnerOf(path.ownerId));

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

    const copy =
        leaving === targets.length
            ? {
                  title: isSingle ? 'Remove shared item' : `Remove ${targets.length} shared items`,
                  description: isSingle
                      ? 'This item is shared with you. Removing it only takes away your access, and the owner can share it again. Remove'
                      : `These ${targets.length} items are shared with you. Removing them only takes away your access, and the owners can share them again.`,
                  deleteText: 'Remove',
              }
            : {
                  title: isSingle ? 'Move to trash' : `Move ${targets.length} items to trash`,
                  description: isSingle
                      ? foreign
                          ? 'This item is in someone else’s drive. It goes to their trash, and only they can restore it. Move'
                          : 'You can restore it later from the trash. Move'
                      : `This will move ${targets.length} items to trash.${
                            foreign
                                ? ' Items from other drives go to their owner’s trash, and only the owner can restore them.'
                                : ' You can restore them later from the trash.'
                        }${leaving ? ` ${leaving} of them are shared with you and will only be removed from your view.` : ''}`,
                  deleteText: 'Move to trash',
              };

    return (
        <DeleteDialog
            open={open}
            onOpenChange={onOpenChange}
            title={copy.title}
            description={copy.description}
            itemName={isSingle && first ? stripEigenExtension(first.name) : undefined}
            onDelete={handleDelete}
            deleteText={copy.deleteText}
        />
    );
}
