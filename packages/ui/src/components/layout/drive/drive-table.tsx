import React, {KeyboardEvent, useEffect, useMemo, useRef, useState} from "react";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@workspace/ui/components/table";
import {cn} from "@workspace/ui/lib/utils";
import {formatDistanceToNow} from "date-fns";
import {DrivePath} from "@apps/api-server/types/drive";
import {DriveShareSummary} from "./drive-share-summary";
import {ArrowRight, ChevronLeft, Download, Trash2, UserRoundPlus, Pencil} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";

// Props for the DriveTable component   
export interface DriveTableProps {
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

    // Ref voor de tabel element
    const tableRef = useRef<HTMLTableElement>(null);

    // State om bij te houden of de tabel focus heeft
    const [hasFocus, setHasFocus] = useState(false);

    // State voor het bijhouden van de huidige geselecteerde index
    const [selectedIndex, setSelectedIndex] = useState<number>(-1);

    // State for the context menu
    const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number, y: number } | null>(null);
    const [contextMenuItem, setContextMenuItem] = useState<DrivePath | null>(null);
    
    // Drag and drop state
    const [draggedItem, setDraggedItem] = useState<DrivePath | null>(null);
    const [dragOverItem, setDragOverItem] = useState<string | null>(null);
    const [isValidDropTarget, setIsValidDropTarget] = useState<boolean>(false);

    // Bepaal of er een parent navigatie-item is
    const hasParentItem = Boolean(currentPath?.parentId);

    // Sort items: folders first, then sort alphabetically by name
    const sortedItems = useMemo(() => {
        return [...items].sort((a, b) => {
            // First sort by type (folders first)
            if (a.type === 'folder' && b.type !== 'folder') {
                return -1;
            }
            if (a.type !== 'folder' && b.type === 'folder') {
                return 1;
            }

            // Then sort alphabetically by name
            return a.name.localeCompare(b.name, undefined, {sensitivity: 'base'});
        });
    }, [items]);

    // Create a combined item list including the parent folder
    const allItems = useMemo(() => {
        const result = [...sortedItems];

        // If there's a parent item, add a placeholder at the beginning
        if (hasParentItem && currentPath?.parentId) {
            result.unshift({
                id: currentPath.parentId,
                name: '..',
                type: 'folder',
                parentId: undefined,
                ownerId: currentPath.ownerId || '',
                labels: [],
                mimeType: 'folder',
                size: 0,
                thumbnail: '',
                acl: null,
                createdAt: new Date(),
                updatedAt: new Date()
            });
        }

        return result;
    }, [sortedItems, hasParentItem, currentPath]);

    // Effect om de tabel automatisch focus te geven bij het laden
    useEffect(() => {
        // Korte timeout om ervoor te zorgen dat de tabel eerst gerenderd is
        const timer = setTimeout(() => {
            if (tableRef.current) {
                tableRef.current.focus();
            }
        }, 100);

        return () => clearTimeout(timer);
    }, []);

    // Effect om selectedIndex bij te werken wanneer activeItemId verandert
    useEffect(() => {
        if (activeItemId) {
            const index = allItems.findIndex(item => item.id === activeItemId);
            if (index !== -1) {
                setSelectedIndex(index);
            }
        } else {
            setSelectedIndex(-1);
        }
    }, [activeItemId, allItems]);

    // Handel toetsenbord navigatie af
    const handleKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
        if (!hasFocus || allItems.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.min(prev + 1, allItems.length - 1);
                    if (newIndex >= 0 && newIndex !== prev) {
                        if (!hasParentItem || newIndex > 0) {
                            const targetItem = allItems[newIndex];
                            onItemClick?.(targetItem);
                        }
                        // Auto-scroll indien nodig
                        scrollToRow(newIndex);
                    }
                    return newIndex;
                });
                break;

            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.max(prev - 1, 0);
                    if (newIndex >= 0 && newIndex !== prev) {
                        if (!hasParentItem || newIndex > 0) {
                            const targetItem = allItems[newIndex];
                            onItemClick?.(targetItem);
                        }
                        // Auto-scroll indien nodig
                        scrollToRow(newIndex);
                    }
                    return newIndex;
                });
                break;

            case ' ':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < allItems.length) {
                    // Bij Enter altijd onItemClick uitvoeren, ook voor folders
                    onItemClick?.(allItems[selectedIndex]);
                }
                break;

            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < allItems.length) {
                    // Bij Enter altijd onItemClick uitvoeren, ook voor folders
                    onItemClick?.(allItems[selectedIndex]);
                }
                break;

            case 'Delete':
                e.preventDefault();
                if (onDelete && selectedIndex >= 0 && selectedIndex < allItems.length) {
                    onDelete(allItems[selectedIndex]);
                }
                break;

            case 'PageUp':
            case 'Home':
                e.preventDefault();
                if (allItems.length > 0) {
                    setSelectedIndex(0);
                    scrollToRow(0);
                }
                break;

            case 'PageDown':
            case 'End':
                e.preventDefault();
                if (allItems.length > 0) {
                    const lastIndex = allItems.length - 1;
                    setSelectedIndex(lastIndex);

                    if (!hasParentItem || lastIndex > 0) {
                        const targetItem = allItems[lastIndex];
                        onItemClick?.(targetItem);
                    }

                    scrollToRow(lastIndex);
                }
                break;
        }
    };

    // Helper functie om naar een specifieke rij te scrollen
    const scrollToRow = (index: number) => {
        if (tableRef.current) {
            const rows = tableRef.current.querySelectorAll('tbody tr');
            if (rows[index]) {
                rows[index].scrollIntoView({behavior: 'smooth', block: 'nearest'});
            }
        }
    };

    // Handle right-click on table row
    const handleContextMenu = (e: React.MouseEvent, item: DrivePath) => {
        e.preventDefault();
        setContextMenuPosition({x: e.clientX, y: e.clientY});
        setContextMenuItem(item);
    };

    // Close context menu
    const closeContextMenu = () => {
        setContextMenuPosition(null);
        setContextMenuItem(null);
    };

    // Handle drag start event
    const handleDragStart = (e: React.DragEvent, item: DrivePath) => {
        setDraggedItem(item);
        // Set data transfer properties
        e.dataTransfer.setData('text/plain', item.id);
        e.dataTransfer.setData('application/eigen', JSON.stringify({
            id: item.id,
            type: item.type
        }));
        e.dataTransfer.effectAllowed = 'move';
    };

    // Handle drag over event
    const handleDragOver = (e: React.DragEvent, item: DrivePath) => {
        e.preventDefault();
        if (!draggedItem) return;
        
        // Check if this is a valid drop target
        const isValid = isValidDrop(draggedItem, item);
        
        if (isValid) {
            e.dataTransfer.dropEffect = 'move';
        } else {
            e.dataTransfer.dropEffect = 'none';
        }
    };
    
    // Handle drag enter event
    const handleDragEnter = (item: DrivePath) => {
        if (!draggedItem) return;
        
        setDragOverItem(item.id);
        setIsValidDropTarget(isValidDrop(draggedItem, item));
    };
    
    // Handle drag leave event
    const handleDragLeave = () => {
        //setDragOverItem(null);
        //setIsValidDropTarget(false);
    };
    
    // Handle drop event
    const handleDrop = (e: React.DragEvent, targetItem: DrivePath) => {
        e.preventDefault();
        
        if (!draggedItem) return;
        
        // Check if this is a valid drop
        if (isValidDrop(draggedItem, targetItem)) {
            // Handle the move based on the item type
            onMove?.(draggedItem, targetItem.id);
        }
        
        // Reset drag state
        setDraggedItem(null);
        setDragOverItem(null);
        setIsValidDropTarget(false);
    };
    
    // Handle drag end event
    const handleDragEnd = () => {
        setDraggedItem(null);
        setDragOverItem(null);
        setIsValidDropTarget(false);
    };
    
    // Check if a drop is valid
    const isValidDrop = (source: DrivePath, target: DrivePath): boolean => {
        // Can't drop on itself
        if (source.id === target.id) return false;
        
        // Can only drop on folders
        if (target.type !== 'folder') return false;
        
        // Can't drop a folder on its own child (would create circular reference)
        // This would require more complex logic with knowledge of the folder hierarchy
        
        return true;
    };

    return (
        <div className="flex-1 overflow-auto">
            <Table
                ref={tableRef}
                tabIndex={0} // Maak de tabel focusable
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
                    {/* Parent folder navigation row */}
                    {hasParentItem && (
                        <TableRow
                            className={cn(
                                "eigen-list-item",
                                (activeItemId === currentPath?.parentId || selectedIndex === 0) && "eigen-list-item-active"
                            )}
                            onClick={() => onItemClick?.({
                                id: currentPath?.parentId || '',
                                name: '..',
                                type: 'folder',
                                parentId: undefined,
                                ownerId: currentPath?.ownerId || '',
                                labels: [],
                                mimeType: 'folder',
                                size: 0,
                                thumbnail: '',
                                acl: null,
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
                        // Adjust index based on whether there's a parent item
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

            {/* Context Menu using shadcn dropdown-menu */}
            <DropdownMenu
                open={!!contextMenuPosition}
                onOpenChange={(open) => !open && closeContextMenu()}
            >
                <DropdownMenuTrigger className="hidden">
                    {/* Hidden trigger */}
                </DropdownMenuTrigger>

                <DropdownMenuContent
                    style={{
                        position: 'absolute',
                        top: `${contextMenuPosition?.y || -1000}px`,
                        left: `${contextMenuPosition?.x || -1000}px`,
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
            </DropdownMenu>
        </div>
    );
}
