import { subjectFromPath } from '@workspace/lib/file-subject';
import type { DrivePath } from '@workspace/lib/types';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { Copy, CopyPlus, FolderInput, Trash2 } from 'lucide-react';
import type React from 'react';
import { useMemo } from 'react';
import { ContextMenuAnchor } from '../context-menu';
import { useFileActionRunner } from '../file-actions/use-file-action-runner';
import { DriveItemMenuItems } from './drive-item-menu';
import type { useDriveItemController } from './use-drive-item-controller';

type DriveItemContextMenuProps = {
    controller: ReturnType<typeof useDriveItemController>;
    // The listing behind the menu, in its display order: Quick preview pages through it.
    items: DrivePath[];
    getItemHref?: (item: DrivePath) => string | undefined;
    onItemOpen?: (item: DrivePath) => void;
    onExport?: (item: DrivePath, format: string) => void;
    onRename?: (item: DrivePath) => void;
    onMoveTo?: (items: DrivePath[]) => void;
    onCopyTo?: (items: DrivePath[]) => void;
    onDuplicate?: (items: DrivePath[]) => void;
    onShareClick?: (item: DrivePath) => void;
    onEmailCollaborators?: (item: DrivePath) => void;
    onDelete?: (items: DrivePath[]) => void;
    allowDelete?: boolean;
    // The view's own write capability: a read-only feed's subjects offer no row that writes beside them.
    canWrite?: boolean;
    // Replaces the default menu body — used by listings with their own actions (trash).
    renderItems?: (items: DrivePath[], close: () => void) => React.ReactNode;
};

function contextItemsOf({ contextMenu, selection }: DriveItemContextMenuProps['controller']): DrivePath[] {
    if (!contextMenu.item) return [];
    return selection.selectedCount > 1 ? selection.selectedItems : [contextMenu.item];
}

export function DriveItemContextMenu(props: DriveItemContextMenuProps) {
    // Separate components: a listing with its own body (trash) draws no registry row, so it must not mount the runner.
    if (props.renderItems) {
        const { contextMenu } = props.controller;
        const contextItems = contextItemsOf(props.controller);
        return (
            <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
                {contextItems.length > 0 && props.renderItems(contextItems, contextMenu.close)}
            </ContextMenuAnchor>
        );
    }
    return <DriveItemActionsMenu {...props} />;
}

function DriveItemActionsMenu({
    controller,
    items,
    getItemHref,
    onItemOpen,
    onExport,
    onRename,
    onMoveTo,
    onCopyTo,
    onDuplicate,
    onShareClick,
    onEmailCollaborators,
    onDelete,
    allowDelete,
    canWrite = true,
}: DriveItemContextMenuProps) {
    const { contextMenu } = controller;
    const contextItems = contextItemsOf(controller);

    const subject = useMemo(
        () => (contextMenu.item ? subjectFromPath(contextMenu.item, { canWrite }) : null),
        [contextMenu.item, canWrite],
    );
    // Mapped only while the menu is open: a folder listing can run to thousands of rows.
    const siblings = useMemo(
        () => (contextMenu.item ? items.map((item) => subjectFromPath(item, { canWrite })) : []),
        [contextMenu.item, items, canWrite],
    );
    const runner = useFileActionRunner(subject, siblings);

    const isSingleSelect = contextItems.length === 1;
    const contextMenuItemHref = isSingleSelect && contextMenu.item ? getItemHref?.(contextMenu.item) : undefined;

    return (
        <>
            <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
                {isSingleSelect && contextMenu.item && (
                    <DriveItemMenuItems
                        item={contextMenu.item}
                        runner={runner}
                        href={contextMenuItemHref}
                        onClose={contextMenu.close}
                        onItemOpen={onItemOpen}
                        onExport={onExport}
                        onRename={onRename}
                        onMoveTo={onMoveTo}
                        onCopyTo={onCopyTo}
                        onDuplicate={onDuplicate}
                        onShareClick={onShareClick}
                        onEmailCollaborators={onEmailCollaborators}
                        onDelete={onDelete}
                        allowDelete={allowDelete}
                    />
                )}
                {!isSingleSelect && contextItems.length > 0 && (
                    <>
                        {onMoveTo && (
                            <DropdownMenuItem
                                onClick={() => {
                                    onMoveTo(contextItems);
                                    contextMenu.close();
                                }}
                                className="flex items-center"
                            >
                                <FolderInput className="h-4 w-4 mr-2" />
                                Move {contextItems.length} items to…
                            </DropdownMenuItem>
                        )}
                        {onCopyTo && (
                            <DropdownMenuItem
                                onClick={() => {
                                    onCopyTo(contextItems);
                                    contextMenu.close();
                                }}
                                className="flex items-center"
                            >
                                <Copy className="h-4 w-4 mr-2" />
                                Copy {contextItems.length} items to…
                            </DropdownMenuItem>
                        )}
                        {onDuplicate && (
                            <DropdownMenuItem
                                onClick={() => {
                                    onDuplicate(contextItems);
                                    contextMenu.close();
                                }}
                                className="flex items-center"
                            >
                                <CopyPlus className="h-4 w-4 mr-2" />
                                Duplicate {contextItems.length} items
                            </DropdownMenuItem>
                        )}
                    </>
                )}
                {!isSingleSelect && allowDelete && contextItems.length > 0 && (
                    <DropdownMenuItem
                        onClick={() => {
                            onDelete?.(contextItems);
                            contextMenu.close();
                        }}
                        className="flex items-center"
                    >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Move {contextItems.length} items to trash
                    </DropdownMenuItem>
                )}
            </ContextMenuAnchor>
            {runner.dialogs}
        </>
    );
}
