// Drive's Trash: what the viewer deleted, newest trashed first, with Restore and Delete permanently on
// each row's menu and in the command palette, and Empty trash for everything at once. The rows have
// no other actions, so the page hands the list its own rows instead of the Drive item menu's.

import { createFileRoute } from '@tanstack/react-router';
import {
    DEFAULT_MOUNT_ID,
    getDriveComparator,
    PartialBatchError,
    useDriveViewPreferences,
    useEmptyTrash,
    useListTrash,
    usePermanentlyDelete,
    useRestorePath,
} from '@workspace/lib/drive';
import type { PaletteSelectionAction } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Column, ColumnLayout, DeleteDialog, LoadingState, ToolbarTitle } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { DriveList, DriveViewControls } from '@workspace/ui/components/drive/drive-list';
import type { DriveListDate } from '@workspace/ui/components/drive/drive-table';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

export const Route = createFileRoute('/_auth/trash')({
    component: TrashRoute,
});

const TRASHED: DriveListDate = { label: 'Trashed', of: (item) => item.trashedAt };

function TrashToolbar({ itemCount, onEmptyTrash }: { itemCount: number; onEmptyTrash: () => void }) {
    return (
        <div className="flex items-center justify-between w-full">
            <ToolbarTitle>Trash</ToolbarTitle>
            <div className="flex items-center gap-1">
                <DriveViewControls dateLabel={TRASHED.label} />
                {itemCount > 0 && (
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
    const ownerId = user.id;
    const mountId = DEFAULT_MOUNT_ID;

    const { data: trashedItems = [], isLoading, error } = useListTrash(ownerId, mountId);
    const restorePath = useRestorePath(ownerId, mountId);
    const permanentlyDelete = usePermanentlyDelete(ownerId, mountId);
    const emptyTrash = useEmptyTrash(ownerId, mountId);

    const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
    const [deleteItems, setDeleteItems] = useState<readonly DrivePath[]>([]);

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
                for (const item of items) restorePath.mutate(item.id);
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
            run: () => setDeleteItems(items),
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
                    toolbar={
                        <TrashToolbar itemCount={trashedItems.length} onEmptyTrash={() => setEmptyTrashOpen(true)} />
                    }
                >
                    <DriveList
                        items={sortedItems}
                        error={error}
                        ownerId={ownerId}
                        mountId={mountId}
                        hideOwner
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
                description="Are you sure you want to permanently delete all items in trash? This action cannot be undone."
                onDelete={async () => {
                    await emptyTrash.mutateAsync();
                }}
                deleteText="Empty trash"
            />

            <DeleteDialog
                open={deleteItems.length > 0}
                onOpenChange={(open) => {
                    if (!open) setDeleteItems([]);
                }}
                title="Delete permanently"
                description={
                    deleteItems.length > 1
                        ? `Are you sure you want to permanently delete ${deleteItems.length} items? This action cannot be undone.`
                        : 'Are you sure you want to permanently delete'
                }
                itemName={deleteItems.length === 1 ? deleteItems[0].name : undefined}
                onDelete={async () => {
                    await permanentlyDelete.mutateAsync(deleteItems).catch((error: unknown) => {
                        if (error instanceof PartialBatchError) setDeleteItems(error.failed);
                        throw error;
                    });
                }}
                deleteText="Delete permanently"
            />
        </>
    );
}
