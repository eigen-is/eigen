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
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { LoadingState } from '@workspace/ui/components/layout/app/loading-state';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { getFileIcon } from '@workspace/ui/components/layout/drive';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';

export const Route = createFileRoute('/_auth/trash')({
    component: TrashRoute,
});

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

    const handleRestore = (pathId: string) => {
        restorePath.mutate(pathId);
    };

    const handlePermanentlyDelete = (pathId: string, name: string) => {
        setDeleteItemId(pathId);
        setDeleteItemName(name);
        setDeleteItemOpen(true);
    };

    const confirmPermanentlyDelete = () => {
        if (deleteItemId) {
            permanentlyDelete.mutate(deleteItemId);
            setDeleteItemOpen(false);
            setDeleteItemId(null);
        }
    };

    const handleEmptyTrash = () => {
        emptyTrash.mutate();
        setEmptyTrashOpen(false);
    };

    if (isLoading) {
        return <LoadingState />;
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b px-4 py-2">
                <h2 className="text-sm font-medium">Trash</h2>
                {trashedItems.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => setEmptyTrashOpen(true)}>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Empty trash
                    </Button>
                )}
            </div>

            {trashedItems.length === 0 ? (
                <EmptyState message="Trash is empty" icon={<Trash2 className="h-10 w-10" />} />
            ) : (
                <div className="flex-1 overflow-auto">
                    <Table className="eigen-table">
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-[60%]">Name</TableHead>
                                <TableHead className="w-[20%] hidden sm:table-cell">Trashed</TableHead>
                                <TableHead className="w-[20%] text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {trashedItems.map((item) => (
                                <TableRow key={item.id} className="eigen-list-item">
                                    <TableCell>
                                        <div className="flex items-center max-w-full overflow-hidden">
                                            {getFileIcon(item.mimeType, item.type, {
                                                className: 'h-4 w-4 mr-2 text-muted-foreground flex-shrink-0',
                                            })}
                                            <span className="truncate max-w-[calc(100%-1.5rem)]">
                                                {stripEigenExtension(item.name)}
                                            </span>
                                        </div>
                                    </TableCell>
                                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                                        {item.trashedAt ? formatDateTime(item.trashedAt) : '-'}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex items-center justify-end gap-1">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8"
                                                onClick={() => handleRestore(item.id)}
                                                title="Restore"
                                            >
                                                <RotateCcw className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 text-destructive hover:text-destructive"
                                                onClick={() => handlePermanentlyDelete(item.id, item.name)}
                                                title="Delete permanently"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            <DeleteDialog
                open={emptyTrashOpen}
                onOpenChange={setEmptyTrashOpen}
                title="Empty trash"
                description="Are you sure you want to permanently delete all items in trash? This action cannot be undone."
                onDelete={handleEmptyTrash}
                deleteText="Empty trash"
            />

            <DeleteDialog
                open={deleteItemOpen}
                onOpenChange={setDeleteItemOpen}
                title="Delete permanently"
                description="Are you sure you want to permanently delete"
                itemName={deleteItemName}
                onDelete={confirmPermanentlyDelete}
                deleteText="Delete permanently"
            />
        </div>
    );
}
