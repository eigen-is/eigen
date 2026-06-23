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
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { EmptyState } from '@workspace/ui/components/layout/app/empty-state';
import { LoadingState } from '@workspace/ui/components/layout/app/loading-state';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { getFileIcon, getFilePresentation } from '@workspace/ui/components/layout/drive';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { cn } from '@workspace/ui/lib/utils';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';

export const Route = createFileRoute('/_auth/trash')({
    component: TrashRoute,
});

function TrashToolbar({ itemCount, onEmptyTrash }: { itemCount: number; onEmptyTrash: () => void }) {
    return (
        <div className="flex items-center justify-between w-full">
            <ToolbarTitle>Trash</ToolbarTitle>
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

    const gridCols = 'grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_15%]';

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
                        <div className="flex-1 overflow-auto text-sm">
                            <div className={cn('grid app-gutter-x', gridCols, 'border-b')}>
                                <div className="eigen-section-label h-10 pr-2 flex items-center">Name</div>
                                <div className="eigen-section-label h-10 pr-2 hidden sm:flex items-center justify-end">
                                    Trashed
                                </div>
                            </div>
                            {trashedItems.map((item) => {
                                const presentation = getFilePresentation(item.mimeType, item.type);
                                return (
                                    <div
                                        key={item.id}
                                        className={cn(
                                            'grid app-gutter-x',
                                            gridCols,
                                            'border-b transition-colors eigen-list-item group',
                                        )}
                                        onContextMenu={(e) => contextMenu.handleContextMenu(e, item)}
                                    >
                                        <div className="pr-2 py-2.5 flex items-center min-w-0 relative">
                                            {getFileIcon(item.mimeType, item.type, {
                                                className: 'h-4 w-4 mr-2 flex-shrink-0',
                                                style: {
                                                    color: presentation.colorVar,
                                                    fill: presentation.fillColorVar,
                                                },
                                            })}
                                            <span className="truncate">{stripEigenExtension(item.name)}</span>
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
                                        </div>
                                        <div className="hidden sm:flex items-center justify-end pr-2 py-1.5 text-xs text-muted-foreground whitespace-nowrap">
                                            {item.trashedAt ? formatDateTime(item.trashedAt) : '-'}
                                        </div>
                                    </div>
                                );
                            })}

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
