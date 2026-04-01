import { createFileRoute } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { formatDateTime } from '@workspace/lib/date';
import {
    DEFAULT_MOUNT_ID,
    useEmptyTrash,
    useListTrash,
    usePermanentlyDelete,
    useRestorePath,
} from '@workspace/lib/drive';
import { stripEigenExtension } from '@workspace/lib/types';
import { Button } from '@workspace/ui/components/button';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { LoadingState } from '@workspace/ui/components/layout/app/loading-state';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { getFileIcon } from '@workspace/ui/components/layout/drive';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';

export const Route = createFileRoute('/_auth/trash')({
    component: TrashRoute,
});

function TrashToolbar({ itemCount, onEmptyTrash }: { itemCount: number; onEmptyTrash: () => void }) {
    return (
        <div className="flex items-center justify-between w-full">
            <span className="text-lg font-medium">Trash</span>
            {itemCount > 0 && (
                <Button variant="outline" size="sm" onClick={onEmptyTrash}>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Empty trash
                </Button>
            )}
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
    const [deleteItemOpen, setDeleteItemOpen] = useState(false);
    const [deleteItemId, setDeleteItemId] = useState<string | null>(null);
    const [deleteItemName, setDeleteItemName] = useState<string>('');

    if (isLoading) return <LoadingState />;

    return (
        <>
            <ColumnLayout>
                <Column
                    id="trash"
                    width="flex"
                    toolbar={
                        <TrashToolbar itemCount={trashedItems.length} onEmptyTrash={() => setEmptyTrashOpen(true)} />
                    }
                >
                    {trashedItems.length === 0 ? (
                        <EmptyState message="Trash is empty" icon={<Trash2 className="h-10 w-10" />} />
                    ) : (
                        <div className="h-full overflow-auto">
                            <Table className="eigen-table">
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Name</TableHead>
                                        <TableHead className="w-40 hidden sm:table-cell">Trashed</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {trashedItems.map((item) => (
                                        <TableRow key={item.id} className="eigen-list-item group">
                                            <TableCell>
                                                <div className="flex items-center overflow-hidden">
                                                    {getFileIcon(item.mimeType, item.type, {
                                                        className: 'h-4 w-4 mr-2 text-muted-foreground flex-shrink-0',
                                                    })}
                                                    <span className="truncate">{stripEigenExtension(item.name)}</span>
                                                    <div className="invisible group-hover:visible flex items-center ml-auto pl-2 flex-shrink-0">
                                                        <TooltipButton
                                                            icon={RotateCcw}
                                                            tooltipText="Restore"
                                                            className="h-7 w-7"
                                                            onClick={() => restorePath.mutate(item.id)}
                                                        />
                                                        <TooltipButton
                                                            icon={Trash2}
                                                            tooltipText="Delete permanently"
                                                            className="h-7 w-7 text-destructive hover:text-destructive"
                                                            onClick={() => {
                                                                setDeleteItemId(item.id);
                                                                setDeleteItemName(item.name);
                                                                setDeleteItemOpen(true);
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell className="hidden sm:table-cell text-muted-foreground">
                                                {item.trashedAt ? formatDateTime(item.trashedAt) : '-'}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </Column>
            </ColumnLayout>

            <DeleteDialog
                open={emptyTrashOpen}
                onOpenChange={setEmptyTrashOpen}
                title="Empty trash"
                description="Are you sure you want to permanently delete all items in trash? This action cannot be undone."
                onDelete={() => {
                    emptyTrash.mutate();
                    setEmptyTrashOpen(false);
                }}
                deleteText="Empty trash"
            />

            <DeleteDialog
                open={deleteItemOpen}
                onOpenChange={setDeleteItemOpen}
                title="Delete permanently"
                description="Are you sure you want to permanently delete"
                itemName={deleteItemName}
                onDelete={() => {
                    if (deleteItemId) {
                        permanentlyDelete.mutate(deleteItemId);
                        setDeleteItemOpen(false);
                        setDeleteItemId(null);
                    }
                }}
                deleteText="Delete permanently"
            />
        </>
    );
}
