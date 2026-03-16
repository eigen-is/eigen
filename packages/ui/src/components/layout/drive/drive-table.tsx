import React, {useCallback, useMemo, useRef, useState} from "react";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@workspace/ui/components/table";
import {cn} from "@workspace/ui/lib/utils";
import {formatDistanceToNow} from "date-fns";
import {DEFAULT_MOUNT_ID, DrivePath, isDocumentType, isFolderType, isInlineEditable} from "@workspace/lib/types";
import {DriveShareSummary} from "./drive-share-summary";
import {ArrowRight, ChevronLeft, Download, Pencil, Trash2, UserRoundPlus} from "lucide-react";
import {DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator} from "@workspace/ui/components/dropdown-menu";
import {useContextMenu} from "../context-menu/use-context-menu";
import {ContextMenuAnchor} from "../context-menu/context-menu-anchor";
import {useKeyboardListNavigation} from "../../../hooks/use-keyboard-list-navigation";
import {useListSelection} from "../../../hooks/use-list-selection";
import {useListDrag} from "../../../hooks/use-list-drag";

export function defaultDriveSort(a: DrivePath, b: DrivePath): number {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'});
}

export type DriveTableProps = {
    items: DrivePath[];
    currentPath?: DrivePath | null;
    activeItemId?: string;
    onItemClick?: (item: DrivePath) => void;
    onItemOpen?: (item: DrivePath) => void;
    getFileIcon?: (mimeType: string, type: string, props?: any) => React.ReactNode;
    onShareClick?: (item: DrivePath) => void;
    onDownload?: (item: DrivePath) => void;
    onDelete?: (items: DrivePath[]) => void;
    onRename?: (item: DrivePath) => void;
    onMove?: (item: DrivePath, targetItemId: string) => void;
    onQuickLook?: (item: DrivePath) => void;
    sortFn?: (a: DrivePath, b: DrivePath) => number;
    allowDelete?: boolean;
    allowDownload?: boolean;
}

export function DriveTable({
                               items = [],
                               currentPath,
                               activeItemId,
                               onItemClick,
                               onItemOpen,
                               getFileIcon,
                               onShareClick,
                               onDownload,
                               onDelete,
                               onRename,
                               onMove,
                               onQuickLook,
                               sortFn = defaultDriveSort,
                               allowDelete = false,
                           }: DriveTableProps) {

    const tableRef = useRef<HTMLTableElement>(null);
    const [hasFocus, setHasFocus] = useState(false);
    const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);

    const hasParentItem = Boolean(currentPath?.parentId);

    const sortedItems = useMemo(() => {
        return [...items].sort(sortFn);
    }, [items, sortFn]);

    const allItems = useMemo(() => {
        const result = [...sortedItems];
        if (hasParentItem && currentPath?.parentId) {
            result.unshift({
                id: currentPath.parentId,
                mountId: currentPath.mountId || DEFAULT_MOUNT_ID,
                name: '..',
                type: 'folder',
                parentId: null,
                ownerId: currentPath.ownerId || '',
                labels: [],
                mimeType: 'folder',
                size: 0,
                thumbnail: null,
                acl: null,
                visibility: 'private',
                details: null,
                createdAt: new Date(),
                updatedAt: new Date()
            });
        }
        return result;
    }, [sortedItems, hasParentItem, currentPath]);

    const handleItemSelect = useCallback((id: string) => {
        const item = allItems.find(i => i.id === id);
        if (item) onItemClick?.(item);
    }, [allItems, onItemClick]);

    const handleQuickLook = useCallback((id: string) => {
        if (!onQuickLook) return;
        const item = allItems.find(i => i.id === id);
        if (item) onQuickLook(item);
    }, [allItems, onQuickLook]);

    const selection = useListSelection({items: allItems, getId: (item) => item.id});

    const {selectedIndex, handleKeyDown} = useKeyboardListNavigation<DrivePath>({
        items: allItems,
        activeId: activeItemId,
        getId: (item) => item.id,
        onSelect: handleItemSelect,
        onQuickLook: onQuickLook ? handleQuickLook : undefined,
        containerRef: tableRef,
        itemSelector: 'tbody tr',
        shouldNotify: (_item, index) => (!hasParentItem || index > 0) && !!activeItemId,
        selection,
    });

    const drag = useListDrag({selection, getId: (item) => item.id, dragType: 'drive-item'});

    const contextMenu = useContextMenu<DrivePath>();

    const handleContextMenu = (e: React.MouseEvent, item: DrivePath) => {
        if (!selection.isSelected(item.id)) {
            selection.select(item.id);
        }
        contextMenu.handleContextMenu(e, item);
    };

    const contextItems = contextMenu.item
        ? (selection.selectedCount > 1 ? selection.selectedItems : [contextMenu.item])
        : [];
    const isSingleSelect = contextItems.length === 1;

    const isValidFolderDrop = (targetItem: DrivePath) => {
        if (targetItem.type !== 'folder') return false;
        return !drag.draggedItems.some(d => d.id === targetItem.id);
    };

    return (
        <div className="flex-1 overflow-auto">
            <Table
                ref={tableRef}
                tabIndex={0}
                onFocus={() => setHasFocus(true)}
                onBlur={() => setHasFocus(false)}
                onKeyDown={handleKeyDown}
                className={cn("eigen-table focus:outline-none", hasFocus && "eigen-table-focused")}
            >
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-[75%]">Name</TableHead>
                        <TableHead className="w-[10%] hidden sm:table-cell">Share</TableHead>
                        <TableHead className="w-[15%] hidden sm:table-cell">Modified</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {hasParentItem && currentPath && (
                        <TableRow
                            className={cn(
                                "eigen-list-item",
                                (activeItemId === currentPath.parentId || selectedIndex === 0) && "eigen-list-item-active",
                                currentPath.parentId && selection.isSelected(currentPath.parentId) && "eigen-list-item-selected"
                            )}
                            onClick={(e) => {
                                const parentId = currentPath.parentId || '';
                                selection.handleItemClick(parentId, e);
                                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                                    onItemClick?.(allItems[0]);
                                }
                            }}
                        >
                            <TableCell className="font-medium">
                                <div className="flex items-center">
                                    <ChevronLeft className="h-4 w-4 mr-2 text-muted-foreground"/>
                                    <span>..</span>
                                </div>
                            </TableCell>
                            <TableCell className="hidden sm:table-cell"></TableCell>
                            <TableCell className="hidden sm:table-cell">-</TableCell>
                        </TableRow>
                    )}

                    {sortedItems.map((item, index) => {
                        const adjustedIndex = hasParentItem ? index + 1 : index;

                        return (
                            <TableRow
                                key={item.id}
                                className={cn(
                                    "eigen-list-item",
                                    (activeItemId === item.id || selectedIndex === adjustedIndex) && "eigen-list-item-active",
                                    selection.isSelected(item.id) && "eigen-list-item-selected",
                                    dragOverItemId === item.id && isValidFolderDrop(item) && "bg-accent"
                                )}
                                onClick={(e) => {
                                    selection.handleItemClick(item.id, e);
                                    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                                        onItemClick?.(item);
                                    }
                                }}
                                onContextMenu={(e) => handleContextMenu(e, item)}
                                {...drag.getDragProps(item)}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    if (drag.isDragging && isValidFolderDrop(item)) {
                                        e.dataTransfer.dropEffect = 'move';
                                    }
                                }}
                                onDragEnter={() => {
                                    if (drag.isDragging) setDragOverItemId(item.id);
                                }}
                                onDragLeave={() => {
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    setDragOverItemId(null);
                                    if (isValidFolderDrop(item) && onMove) {
                                        drag.draggedItems.forEach(d => onMove(d, item.id));
                                    }
                                }}
                            >
                                <TableCell>
                                    <div className="flex items-center max-w-full overflow-hidden">
                                        {getFileIcon && getFileIcon(
                                            item.mimeType,
                                            item.type,
                                            {
                                                className: "h-4 w-4 mr-2 text-muted-foreground flex-shrink-0",
                                                ...(isFolderType(item.type) ? {
                                                    fill: "var(--app-drive-light-color)"
                                                } : {}),
                                                ...(isDocumentType(item.type) ? {
                                                    fill: "var(--app-stickies-light-color)"
                                                } : {})
                                            }
                                        )}
                                        <span
                                            className="truncate max-w-[calc(100%-1.5rem)]">{item.name.replace(/\.eigen(doc|stickies|chat|sheets|slides)$/, "")}</span>
                                    </div>
                                </TableCell>
                                <TableCell className="hidden sm:table-cell group">
                                    <DriveShareSummary
                                        path={item}
                                        onClick={() => onShareClick?.(item)}
                                        showIconOnHover={true}
                                    />
                                </TableCell>
                                <TableCell className="hidden sm:table-cell">
                                    {item.updatedAt ?
                                        formatDistanceToNow(new Date(item.updatedAt), {addSuffix: true}) :
                                        'Unknown'}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>

            <ContextMenuAnchor isOpen={contextMenu.isOpen} onClose={contextMenu.close}>
                <DropdownMenuContent
                    style={{
                        position: 'absolute',
                        top: `${contextMenu.position.y}px`,
                        left: `${contextMenu.position.x}px`,
                    }}
                    className="w-48"
                >
                    {isSingleSelect && contextMenu.item && (contextMenu.item.type !== 'file' || isInlineEditable(contextMenu.item.mimeType, contextMenu.item.name)) && onItemOpen && (
                        <DropdownMenuItem
                            onClick={() => {
                                onItemOpen?.(contextMenu.item!);
                                contextMenu.close();
                            }}
                            className="flex items-center"
                        >
                            <ArrowRight className="h-4 w-4 mr-2"/>
                            Open
                        </DropdownMenuItem>
                    )}
                    {isSingleSelect && onDownload && contextMenu.item?.type === 'file' && (
                        <DropdownMenuItem
                            onClick={() => {
                                onDownload?.(contextMenu.item!);
                                contextMenu.close();
                            }}
                            className="flex items-center"
                        >
                            <Download className="h-4 w-4 mr-2"/>
                            Download
                        </DropdownMenuItem>
                    )}

                    {isSingleSelect && onShareClick && (
                        <DropdownMenuItem
                            onClick={() => {
                                onShareClick?.(contextMenu.item!);
                                contextMenu.close();
                            }}
                            className="flex items-center"
                        >
                            <UserRoundPlus className="h-4 w-4 mr-2"/>
                            Edit access
                        </DropdownMenuItem>
                    )}
                    {isSingleSelect && onRename && (
                        <DropdownMenuItem
                            onClick={() => {
                                onRename?.(contextMenu.item!);
                                contextMenu.close();
                            }}
                            className="flex items-center"
                        >
                            <Pencil className="h-4 w-4 mr-2"/>
                            Rename
                        </DropdownMenuItem>
                    )}

                    {allowDelete && contextItems.length > 0 && (
                        <>
                            {isSingleSelect && (onDownload || onShareClick || onRename) && <DropdownMenuSeparator/>}
                            <DropdownMenuItem
                                onClick={() => {
                                    onDelete?.(contextItems);
                                    contextMenu.close();
                                }}
                                className="flex items-center"
                            >
                                <Trash2 className="h-4 w-4 mr-2"/>
                                {isSingleSelect ? 'Delete' : `Delete ${contextItems.length} items`}
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </ContextMenuAnchor>
        </div>
    );
}
