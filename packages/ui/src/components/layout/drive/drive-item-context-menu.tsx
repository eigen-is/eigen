import type { DrivePath } from '@workspace/lib/types';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { Copy, CopyPlus, FolderInput, Trash2 } from 'lucide-react';
import type React from 'react';
import { ContextMenuAnchor } from '../context-menu';
import { DriveItemMenuItems } from './drive-item-menu';
import type { useDriveItemController } from './use-drive-item-controller';

type DriveItemContextMenuProps = {
    controller: ReturnType<typeof useDriveItemController>;
    getItemHref?: (item: DrivePath) => string | undefined;
    onItemOpen?: (item: DrivePath) => void;
    onQuickLook?: (item: DrivePath) => void;
    onDownload?: (item: DrivePath) => void;
    onConvert?: (item: DrivePath, targetType: 'eigensheets' | 'eigendoc') => void;
    onExport?: (item: DrivePath, format: string) => void;
    onRename?: (item: DrivePath) => void;
    onMoveTo?: (items: DrivePath[]) => void;
    onCopyTo?: (items: DrivePath[]) => void;
    onDuplicate?: (items: DrivePath[]) => void;
    onShareClick?: (item: DrivePath) => void;
    onEmailCollaborators?: (item: DrivePath) => void;
    onDelete?: (items: DrivePath[]) => void;
    allowDelete?: boolean;
    // Replaces the default menu body — used by listings with their own actions (trash).
    renderItems?: (items: DrivePath[], close: () => void) => React.ReactNode;
};

export function DriveItemContextMenu({
    controller,
    getItemHref,
    onItemOpen,
    onQuickLook,
    onDownload,
    onConvert,
    onExport,
    onRename,
    onMoveTo,
    onCopyTo,
    onDuplicate,
    onShareClick,
    onEmailCollaborators,
    onDelete,
    allowDelete,
    renderItems,
}: DriveItemContextMenuProps) {
    const { contextMenu, selection } = controller;

    const contextItems = contextMenu.item
        ? selection.selectedCount > 1
            ? selection.selectedItems
            : [contextMenu.item]
        : [];
    const isSingleSelect = contextItems.length === 1;
    const contextMenuItemHref = isSingleSelect && contextMenu.item ? getItemHref?.(contextMenu.item) : undefined;

    if (renderItems) {
        return (
            <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
                {contextItems.length > 0 && renderItems(contextItems, contextMenu.close)}
            </ContextMenuAnchor>
        );
    }

    return (
        <ContextMenuAnchor contextMenu={contextMenu} className="min-w-48">
            {isSingleSelect && contextMenu.item && (
                <DriveItemMenuItems
                    item={contextMenu.item}
                    href={contextMenuItemHref}
                    onClose={contextMenu.close}
                    onItemOpen={onItemOpen}
                    onQuickLook={onQuickLook}
                    onDownload={onDownload}
                    onConvert={onConvert}
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
    );
}
