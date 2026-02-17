import React, {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useTableDragDrop} from "./use-table-drag-drop";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@workspace/ui/components/table";
import {cn} from "@workspace/ui/lib/utils";
import {formatDistanceToNow} from "date-fns";
import {DrivePath, DEFAULT_MOUNT_ID} from "@workspace/lib/types";
import {DriveShareSummary} from "./drive-share-summary";
import {ArrowRight, ChevronLeft, Download, Pencil, Trash2, UserRoundPlus} from "lucide-react";
import {DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator} from "@workspace/ui/components/dropdown-menu";
import {useContextMenu} from "../context-menu/use-context-menu";
import {ContextMenuAnchor} from "../context-menu/context-menu-anchor";
import {useKeyboardListNavigation} from "../../../hooks/use-keyboard-list-navigation";

export type DriveTableProps = {
    items: DrivePath[];
    currentPath?: DrivePath | null;
    activeItemId?: string;
    onItemClick?: (item: DrivePath) => void;
    onItemOpen?: (item: DrivePath) => void;
    getFileIcon?: (mimeType: string, type: string, props?: any) => React.ReactNode;
    onShareClick?: (item: DrivePath) => void;
    onDownload?: (item: DrivePath) => void;
    onDelete?: (item: DrivePath) => void;
    onRename?: (item: DrivePath) => void;
    onMove?: (item: DrivePath, targetItemId: string) => void;
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
                               allowDelete = false,
                           }: DriveTableProps) {

    const tableRef = useRef<HTMLTableElement>(null);
    const [hasFocus, setHasFocus] = useState(false);

    const hasParentItem = Boolean(currentPath?.parentId);

    const sortedItems = useMemo(() => {
        return [...items].sort((a, b) => {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
            return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'});
        });
    }, [items]);

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
                details: null,
                createdAt: new Date(),
                updatedAt: new Date()
            });
        }
        return result;
    }, [sortedItems, hasParentItem, currentPath]);

    useEffect(() => {
        const timer = setTimeout(() => {
            if (tableRef.current) {
                tableRef.current.focus();
            }
        }, 100);
        return () => clearTimeout(timer);
    }, []);

    const handleItemSelect = useCallback((id: string) => {
        const item = allItems.find(i => i.id === id);
        if (item) onItemClick?.(item);
    }, [allItems, onItemClick]);

    const {selectedIndex, handleKeyDown} = useKeyboardListNavigation<DrivePath>({
        items: allItems,
        activeId: activeItemId,
        getId: (item) => item.id,
        onSelect: handleItemSelect,
        containerRef: tableRef,
        itemSelector: 'tbody tr',
        onDelete,
        shouldNotify: (_item, index) => !hasParentItem || index > 0,
    });

    const {
        dragOverItem,
        isValidDropTarget,
        handleDragStart,
        handleDragOver,
        handleDragEnter,
        handleDragLeave,
        handleDrop,
        handleDragEnd,
    } = useTableDragDrop({onMove});

    const {
        item: contextMenuItem,
        position: contextMenuPosition,
        isOpen: contextMenuOpen,
        handleContextMenu,
        close: closeContextMenu
    } = useContextMenu<DrivePath>();

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
                    {hasParentItem && (
                        <TableRow
                            className={cn(
                                "eigen-list-item",
                                (activeItemId === currentPath?.parentId || selectedIndex === 0) && "eigen-list-item-active"
                            )}
                            onClick={() => onItemClick?.({
                                id: currentPath?.parentId || '',
                                mountId: currentPath?.mountId || DEFAULT_MOUNT_ID,
                                name: '..',
                                type: 'folder',
                                parentId: null,
                                ownerId: currentPath?.ownerId || '',
                                labels: [],
                                mimeType: 'folder',
                                size: 0,
                                thumbnail: null,
                                acl: null,
                                details: null,
                                createdAt: new Date(),
                                updatedAt: new Date()
                            })}
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
                                    dragOverItem === item.id && isValidDropTarget && "bg-accent"
                                )}
                                onClick={() => onItemClick?.(item)}
                                onContextMenu={(e) => handleContextMenu(e, item)}
                                draggable={true}
                                onDragStart={(e) => handleDragStart(e, item)}
                                onDragOver={(e) => handleDragOver(e, item)}
                                onDragEnter={() => handleDragEnter(item)}
                                onDragLeave={() => handleDragLeave()}
                                onDrop={(e) => handleDrop(e, item)}
                                onDragEnd={() => handleDragEnd()}
                            >
                                <TableCell>
                                    <div className="flex items-center max-w-full overflow-hidden">
                                        {getFileIcon && getFileIcon(
                                            item.mimeType,
                                            item.type,
                                            {
                                                className: "h-4 w-4 mr-2 text-muted-foreground flex-shrink-0",
                                                ...(item.type === 'folder' ? {
                                                    className: "h-4 w-4 mr-2 text-drive flex-shrink-0",
                                                    fill: "var(--app-drive-light-color)"
                                                } : {}),
                                                ...(item.type === 'doc' ? {
                                                    className: "h-4 w-4 mr-2 text-docs flex-shrink-0",
                                                    fill: "var(--app-doc-light-color)"
                                                } : {}),
                                                ...(item.type === 'stickies' ? {
                                                    className: "h-4 w-4 mr-2 text-stickies flex-shrink-0",
                                                    fill: "var(--app-stickies-light-color)"
                                                } : {})
                                            }
                                        )}
                                        <span
                                            className="truncate max-w-[calc(100%-1.5rem)]">{item.name.replace(/\.eigen(doc|stickies)$/, "")}</span>
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
                                        formatDistanceToNow(new Date(item.updatedAt instanceof Date ? item.updatedAt : new Date(item.updatedAt)), {addSuffix: true}) :
                                        'Unknown'}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>

            <ContextMenuAnchor isOpen={contextMenuOpen} onClose={closeContextMenu}>
                <DropdownMenuContent
                    style={{
                        position: 'absolute',
                        top: `${contextMenuPosition.y}px`,
                        left: `${contextMenuPosition.x}px`,
                    }}
                    className="w-48"
                >
                    {contextMenuItem && contextMenuItem.type !== 'file' && onItemOpen && (
                        <DropdownMenuItem
                            onClick={() => {
                                onItemOpen?.(contextMenuItem!);
                                closeContextMenu();
                            }}
                            className="flex items-center"
                        >
                            <ArrowRight className="h-4 w-4 mr-2"/>
                            Open
                        </DropdownMenuItem>
                    )}
                    {onDownload && contextMenuItem?.type === 'file' && (
                        <DropdownMenuItem
                            onClick={() => {
                                onDownload?.(contextMenuItem);
                                closeContextMenu();
                            }}
                            className="flex items-center"
                        >
                            <Download className="h-4 w-4 mr-2"/>
                            Download
                        </DropdownMenuItem>
                    )}

                    {onShareClick && (
                        <DropdownMenuItem
                            onClick={() => {
                                onShareClick?.(contextMenuItem!);
                                closeContextMenu();
                            }}
                            className="flex items-center"
                        >
                            <UserRoundPlus className="h-4 w-4 mr-2"/>
                            Edit access
                        </DropdownMenuItem>
                    )}
                    {onRename && (
                        <DropdownMenuItem
                            onClick={() => {
                                onRename?.(contextMenuItem!);
                                closeContextMenu();
                            }}
                            className="flex items-center"
                        >
                            <Pencil className="h-4 w-4 mr-2"/>
                            Rename
                        </DropdownMenuItem>
                    )}

                    {allowDelete && (
                        <>
                            {(onDownload || onShareClick || onRename) && <DropdownMenuSeparator/>}
                            <DropdownMenuItem
                                onClick={() => {
                                    onDelete?.(contextMenuItem!);
                                    closeContextMenu();
                                }}
                                className="flex items-center"
                            >
                                <Trash2 className="h-4 w-4 mr-2"/>
                                Delete
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </ContextMenuAnchor>
        </div>
    );
}
