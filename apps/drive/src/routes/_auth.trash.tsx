import { createFileRoute } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import {
    DEFAULT_MOUNT_ID,
    getDriveComparator,
    useDriveViewPreferences,
    useEmptyTrash,
    useListTrash,
    usePermanentlyDelete,
    useRestorePath,
} from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { DeleteDialog } from '@workspace/ui/components/delete/delete-dialog';
import { DriveList, DriveViewControls } from '@workspace/ui/components/drive/drive-list';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { LoadingState } from '@workspace/ui/components/layout/app/loading-state';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

export const Route = createFileRoute('/_auth/trash')({
    component: TrashRoute,
});

function TrashToolbar({ itemCount, onEmptyTrash }: { itemCount: number; onEmptyTrash: () => void }) {
    return (
        <div className="flex items-center justify-between w-full">
            <ToolbarTitle>Trash</ToolbarTitle>
            <div className="flex items-center gap-1">
                <DriveViewControls />
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
    const auth = useAuth();
    const ownerId = auth.user!.id;
    const mountId = DEFAULT_MOUNT_ID;

    const { data: trashedItems = [], isLoading } = useListTrash(ownerId, mountId);
    const restorePath = useRestorePath(ownerId, mountId);
    const permanentlyDelete = usePermanentlyDelete(ownerId, mountId);
    const emptyTrash = useEmptyTrash(ownerId, mountId);

    const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
    const [deleteItems, setDeleteItems] = useState<DrivePath[]>([]);

    // "Modified" sorts by deletion time here — that's also the date column this page shows.
    const { sortKey, sortDir } = useDriveViewPreferences();
    const sortedItems = useMemo(() => {
        const comparator = getDriveComparator(sortKey, sortDir, (p) => p.trashedAt ?? p.updatedAt);
        return [...trashedItems].sort(comparator);
    }, [trashedItems, sortKey, sortDir]);

    const contextMenuItems = useCallback(
        (items: DrivePath[], close: () => void) => {
            const suffix = items.length > 1 ? ` ${items.length} items` : '';
            return (
                <>
                    <DropdownMenuItem
                        onClick={() => {
                            for (const item of items) restorePath.mutate(item.id);
                            close();
                        }}
                    >
                        <RotateCcw className="h-4 w-4 mr-2" /> Restore{suffix}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        onClick={() => {
                            setDeleteItems(items);
                            close();
                        }}
                        className="text-destructive"
                    >
                        <Trash2 className="h-4 w-4 mr-2" /> Delete{suffix} permanently
                    </DropdownMenuItem>
                </>
            );
        },
        [restorePath],
    );

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
                        ownerId={ownerId}
                        mountId={mountId}
                        hideOwner
                        hideShared
                        dateLabel="Trashed"
                        getItemDate={(item) => item.trashedAt}
                        contextMenuItems={contextMenuItems}
                        emptyState={<EmptyState message="Trash is empty" icon={<Trash2 className="h-10 w-10" />} />}
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
                    await Promise.all(deleteItems.map((item) => permanentlyDelete.mutateAsync(item.id)));
                }}
                deleteText="Delete permanently"
            />
        </>
    );
}
