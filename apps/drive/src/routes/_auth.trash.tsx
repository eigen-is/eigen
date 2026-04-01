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
import type { DrivePath } from '@workspace/lib/types/drive';
import { isFolderType, stripEigenExtension } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { LoadingState } from '@workspace/ui/components/layout/app/loading-state';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
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
            <span className="text-sm text-foreground font-normal">Trash</span>
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

    const contextMenu = useContextMenu<DrivePath>();

    const openPermanentDelete = (id: string, name: string) => {
        setDeleteItemId(id);
        setDeleteItemName(name);
        setDeleteItemOpen(true);
    };

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
                        <div className="flex-1 overflow-auto">
                            <Table className="eigen-table">
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-[85%]">Name</TableHead>
                                        <TableHead className="w-[15%] hidden sm:table-cell">Trashed</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {trashedItems.map((item) => (
                                        <TableRow
                                            key={item.id}
                                            className="eigen-list-item group"
                                            onContextMenu={(e) => contextMenu.handleContextMenu(e, item)}
                                        >
                                            <TableCell className="relative">
                                                <div className="flex items-center max-w-full overflow-hidden">
                                                    {getFileIcon(item.mimeType, item.type, {
                                                        className: 'h-4 w-4 mr-2 text-muted-foreground flex-shrink-0',
                                                        ...(isFolderType(item.type)
                                                            ? { fill: 'var(--app-drive-light-color)' }
                                                            : {}),
                                                    })}
                                                    <span className="truncate max-w-[calc(100%-1.5rem)]">
                                                        {stripEigenExtension(item.name)}
                                                    </span>
                                                </div>
                                                <div className="invisible group-hover:visible absolute right-2 top-1/2 -translate-y-1/2 flex items-center bg-inherit">
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
                                                        onClick={() => openPermanentDelete(item.id, item.name)}
                                                    />
                                                </div>
                                            </TableCell>
                                            <TableCell className="hidden sm:table-cell text-muted-foreground">
                                                {item.trashedAt ? formatDateTime(item.trashedAt) : '-'}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>

                            <ContextMenuAnchor contextMenu={contextMenu} className="w-48">
                                <DropdownMenuItem
                                    onClick={() => {
                                        if (contextMenu.item) restorePath.mutate(contextMenu.item.id);
                                        contextMenu.close();
                                    }}
                                >
                                    <RotateCcw className="h-4 w-4 mr-2" /> Restore
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onClick={() => {
                                        if (contextMenu.item)
                                            openPermanentDelete(contextMenu.item.id, contextMenu.item.name);
                                        contextMenu.close();
                                    }}
                                    className="text-destructive"
                                >
                                    <Trash2 className="h-4 w-4 mr-2" /> Delete permanently
                                </DropdownMenuItem>
                            </ContextMenuAnchor>
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
