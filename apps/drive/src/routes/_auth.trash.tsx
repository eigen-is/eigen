// Drive's Trash: what was deleted from every drive the viewer can restore from, their own and their teams',
// newest trashed first, with Restore and Delete permanently on each row's menu and in the command palette.
// Empty trash empties the viewer's own drives only. The rows have no other actions, so the page hands the
// list its own rows instead of the Drive item menu's.

import { createFileRoute } from '@tanstack/react-router';
import {
    DEFAULT_MOUNT_ID,
    getDriveComparator,
    PartialBatchError,
    useDriveViewPreferences,
    useEmptyTrash,
    usePermanentlyDelete,
    useRestorePath,
    useTrash,
} from '@workspace/lib/drive';
import type { PaletteSelectionAction } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Column, ColumnLayout, DeleteDialog, LoadingState, ToolbarTitle } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { DriveList, DriveViewControls } from '@workspace/ui/components/drive/drive-list';
import type { DriveListDate } from '@workspace/ui/components/drive/drive-table';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

export const Route = createFileRoute('/_auth/trash')({
    component: TrashRoute,
});

const TRASHED: DriveListDate = { label: 'Trashed', of: (item) => item.trashedAt };

function TrashToolbar({ canEmpty, onEmptyTrash }: { canEmpty: boolean; onEmptyTrash: () => void }) {
    return (
        <div className="flex items-center justify-between w-full">
            <ToolbarTitle>Trash</ToolbarTitle>
            <div className="flex items-center gap-1">
                <DriveViewControls dateLabel={TRASHED.label} />
                {canEmpty && (
                    <Button variant="outline" size="sm" onClick={onEmptyTrash}>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Empty trash
                    </Button>
                )}
            </div>
        </div>
    );
}

function TrashRoute() {
    const { user } = Route.useRouteContext();

    const { items: trashedItems, isLoading, error } = useTrash(user.id);
    const restorePath = useRestorePath();
    const permanentlyDelete = usePermanentlyDelete();
    const emptyTrash = useEmptyTrash(user.id);

    const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
    const deleteDialog = useDialogValue<readonly DrivePath[]>();
    const deleteItems = deleteDialog.value;

    // Empty trash takes the viewer's own items only: a team's trash also holds what teammates deleted.
    const ownCount = trashedItems.filter((item) => item.ownerId === user.id).length;

    // The date sort orders by the time an item was trashed, the date this page shows.
    const { sortKey, sortDir } = useDriveViewPreferences();
    const sortedItems = useMemo(() => {
        const comparator = getDriveComparator(sortKey, sortDir, (p) => TRASHED.of(p) ?? p.updatedAt);
        return [...trashedItems].sort(comparator);
    }, [trashedItems, sortKey, sortDir]);

    // What a trashed item offers, drawn by its row's menu and handed to the command palette alike.
    const trashActions = (items: readonly DrivePath[]): PaletteSelectionAction[] => [
        {
            action: {
                id: 'restore',
                label: 'Restore',
                pluralLabel: 'Restore {n} items',
                icon: RotateCcw,
                group: 'organize',
            },
            run: () => {
                for (const item of items) restorePath.mutate(item);
            },
        },
        {
            action: {
                id: 'delete-permanently',
                label: 'Delete permanently',
                pluralLabel: 'Delete {n} items permanently',
                icon: Trash2,
                group: 'destructive',
            },
            run: () => deleteDialog.openDialog(items),
        },
    ];

    if (isLoading) return <LoadingState />;

    return (
        <>
            <ColumnLayout>
                <Column
                    id="trash"
                    width="flex"
                    onBack="sidebar"
                    toolbar={<TrashToolbar canEmpty={ownCount > 0} onEmptyTrash={() => setEmptyTrashOpen(true)} />}
                >
                    <DriveList
                        items={sortedItems}
                        error={error}
                        ownerId={user.id}
                        mountId={DEFAULT_MOUNT_ID}
                        hideShared
                        date={TRASHED}
                        ownActions={trashActions}
                    />
                </Column>
            </ColumnLayout>

            <DeleteDialog
                open={emptyTrashOpen}
                onOpenChange={setEmptyTrashOpen}
                title="Empty trash"
                description={
                    ownCount < trashedItems.length
                        ? 'Are you sure you want to permanently delete all items from your own drive? Items from team drives stay in the trash. This action cannot be undone.'
                        : 'Are you sure you want to permanently delete all items in trash? This action cannot be undone.'
                }
                onDelete={async () => {
                    await emptyTrash.mutateAsync();
                }}
                deleteText="Empty trash"
            />

            {deleteItems && (
                <DeleteDialog
                    open={deleteDialog.open}
                    onOpenChange={deleteDialog.setOpen}
                    title="Delete permanently"
                    description={
                        deleteItems.length > 1
                            ? `Are you sure you want to permanently delete ${deleteItems.length} items? This action cannot be undone.`
                            : 'Are you sure you want to permanently delete'
                    }
                    itemName={deleteItems.length === 1 ? deleteItems[0].name : undefined}
                    onDelete={async () => {
                        await permanentlyDelete.mutateAsync(deleteItems).catch((error: unknown) => {
                            if (error instanceof PartialBatchError) deleteDialog.openDialog(error.failed);
                            throw error;
                        });
                    }}
                    deleteText="Delete permanently"
                />
            )}
        </>
    );
}
