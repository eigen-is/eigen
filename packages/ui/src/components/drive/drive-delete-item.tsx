// The dialog that confirms a Drive delete of one item or a set. It says what the server will do: leave a
// direct share, trash an item in someone else's drive into its owner's trash, or move the viewer's own items
// to their trash. Whoever runs the delete, such as the Drive action runner, opens it when a delete asks first.

import { PartialBatchError, useDeletePaths, useIsEffectiveOwnerOf, useIsSharedWithMe } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { DeleteDialog } from '@workspace/ui/components/delete/delete-dialog';

export type DriveDeleteItemProps = {
    paths: readonly DrivePath[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
    // The dialog stays open after a partial failure, and its owner narrows paths to the failed items for a retry.
    onPartialFailure?: (failed: readonly DrivePath[]) => void;
};

export function DriveDeleteItem({ paths, open, onOpenChange, onAfterAction, onPartialFailure }: DriveDeleteItemProps) {
    const deletePathsMutation = useDeletePaths();
    const isSharedWithMe = useIsSharedWithMe();
    const isEffectiveOwnerOf = useIsEffectiveOwnerOf();

    const isSingle = paths.length === 1;
    // The server leaves a direct share instead of trashing it, and an item in someone else's drive goes to
    // their trash. The dialog's text says which.
    const leaving = paths.filter(isSharedWithMe).length;
    const foreign = paths.some((path) => !isEffectiveOwnerOf(path.ownerId));

    const handleDelete = async () => {
        const deleted = await deletePathsMutation.mutateAsync(paths).catch((error: unknown) => {
            if (error instanceof PartialBatchError) {
                for (const path of error.succeeded) onAfterAction?.('delete', path);
                onPartialFailure?.(error.failed);
            }
            throw error;
        });
        for (const path of deleted) onAfterAction?.('delete', path);
    };

    const copy =
        leaving === paths.length
            ? {
                  title: isSingle ? 'Remove shared item' : `Remove ${paths.length} shared items`,
                  description: isSingle
                      ? 'This item is shared with you. Removing it only takes away your access, and the owner can share it again. Remove'
                      : `These ${paths.length} items are shared with you. Removing them only takes away your access, and the owners can share them again.`,
                  deleteText: 'Remove',
              }
            : {
                  title: isSingle ? 'Move to trash' : `Move ${paths.length} items to trash`,
                  description: isSingle
                      ? foreign
                          ? 'This item is in someone else’s drive. It goes to their trash, and only they can restore it. Move'
                          : 'You can restore it later from the trash. Move'
                      : `This will move ${paths.length} items to trash.${
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
            itemName={isSingle ? stripEigenExtension(paths[0].name) : undefined}
            onDelete={handleDelete}
            deleteText={copy.deleteText}
        />
    );
}
