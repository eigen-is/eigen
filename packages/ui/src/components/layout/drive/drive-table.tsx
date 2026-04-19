import { getDriveShareUrl } from '@workspace/lib/api';
import { copyToClipboard } from '@workspace/lib/clipboard';
import { formatDateTime } from '@workspace/lib/date';
import {
    DEFAULT_MOUNT_ID,
    type DrivePath,
    isFolderType,
    isInlineEditable,
    stripEigenExtension,
} from '@workspace/lib/types';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@workspace/ui/components/table';
import { cn } from '@workspace/ui/lib/utils';
import {
    ArrowRight,
    ChevronLeft,
    Download,
    ExternalLink,
    Eye,
    FileDown,
    Link,
    Mail,
    Pencil,
    Sheet,
    Trash2,
    UserRoundPlus,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useKeyboardListNavigation } from '../../../hooks/use-keyboard-list-navigation';
import { useListDrag } from '../../../hooks/use-list-drag';
import { useListSelection } from '../../../hooks/use-list-selection';
import { ContextMenuAnchor, useContextMenu } from '../context-menu';
import { UnreadDot } from '../unread-dot';
import { DriveShareSummary } from './drive-share-summary';

export function defaultDriveSort(a: DrivePath, b: DrivePath): number {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export type DriveTableProps = {
    items: DrivePath[];
    currentPath?: DrivePath | null;
    activeItemId?: string;
    onItemClick?: (item: DrivePath) => void;
    onItemOpen?: (item: DrivePath) => void;
    getFileIcon?: (mimeType: string, type: string, props?: Record<string, unknown>) => React.ReactNode;
    getItemHref?: (item: DrivePath) => string | undefined;
    onShareClick?: (item: DrivePath) => void;
    onDownload?: (item: DrivePath) => void;
    onDelete?: (items: DrivePath[]) => void;
    onRename?: (item: DrivePath) => void;
    onMove?: (item: DrivePath, targetItemId: string) => void;
    onConvert?: (item: DrivePath, targetType: 'eigensheets') => void;
    onExport?: (item: DrivePath, format: string) => void;
    onQuickLook?: (item: DrivePath) => void;
    onEmailCollaborators?: (item: DrivePath) => void;
    sortFn?: (a: DrivePath, b: DrivePath) => number;
    allowDelete?: boolean;
    ancestorBreadcrumb?: DrivePath[];
    showParentRow?: boolean;
    unreadPathIds?: Set<string>;
};

export function DriveTable({
    items = [],
    currentPath,
    activeItemId,
    onItemClick,
    onItemOpen,
    getFileIcon,
    getItemHref,
    onShareClick,
    onDownload,
    onDelete,
    onRename,
    onMove,
    onConvert,
    onExport,
    onQuickLook,
    onEmailCollaborators,
    sortFn = defaultDriveSort,
    allowDelete = false,
    ancestorBreadcrumb,
    showParentRow,
    unreadPathIds,
}: DriveTableProps) {
    const tableRef = useRef<HTMLTableElement>(null);
    const [hasFocus, setHasFocus] = useState(false);
    const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);

    const hasParentItem = showParentRow ?? Boolean(currentPath?.parentId);

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
                sharingRestricted: false,
                details: null,
                trashedAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        }
        return result;
    }, [sortedItems, hasParentItem, currentPath]);

    const handleItemSelect = useCallback(
        (id: string) => {
            const item = allItems.find((i) => i.id === id);
            if (item) onItemClick?.(item);
        },
        [allItems, onItemClick],
    );

    const handleQuickLook = useCallback(
        (id: string) => {
            if (!onQuickLook) return;
            const item = allItems.find((i) => i.id === id);
            if (item) onQuickLook(item);
        },
        [allItems, onQuickLook],
    );

    const selection = useListSelection({ items: allItems, getId: (item) => item.id });

    const { selectedIndex, handleKeyDown } = useKeyboardListNavigation<DrivePath>({
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

    const drag = useListDrag({ selection, getId: (item) => item.id, dragType: 'drive-item' });

    const contextMenu = useContextMenu<DrivePath>();

    const handleContextMenu = (e: React.MouseEvent, item: DrivePath) => {
        if (!selection.isSelected(item.id)) {
            selection.select(item.id);
        }
        contextMenu.handleContextMenu(e, item);
    };

    const contextItems = contextMenu.item
        ? selection.selectedCount > 1
            ? selection.selectedItems
            : [contextMenu.item]
        : [];
    const isSingleSelect = contextItems.length === 1;
    const contextMenuItemHref = isSingleSelect && contextMenu.item ? getItemHref?.(contextMenu.item) : undefined;

    const isValidFolderDrop = (targetItem: DrivePath) => {
        if (targetItem.type !== 'folder') return false;
        return !drag.draggedItems.some((d) => d.id === targetItem.id);
    };

    return (
        <div className="flex-1 overflow-auto">
            <Table
                ref={tableRef}
                tabIndex={0}
                onFocus={() => setHasFocus(true)}
                onBlur={() => setHasFocus(false)}
                onKeyDown={handleKeyDown}
                className={cn('eigen-table focus:outline-none', hasFocus && 'eigen-table-focused')}
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
                                'eigen-list-item',
                                (activeItemId === currentPath.parentId || selectedIndex === 0) &&
                                    'eigen-list-item-active',
                                currentPath.parentId &&
                                    selection.isSelected(currentPath.parentId) &&
                                    'eigen-list-item-selected',
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
                                    <ChevronLeft className="h-4 w-4 mr-2 text-muted-foreground" />
                                    <span>..</span>
                                </div>
                            </TableCell>
                            <TableCell className="hidden sm:table-cell"></TableCell>
                            <TableCell className="hidden sm:table-cell">-</TableCell>
                        </TableRow>
                    )}

                    {sortedItems.map((item, index) => {
                        const adjustedIndex = hasParentItem ? index + 1 : index;
                        const itemHref = getItemHref?.(item);

                        return (
                            <TableRow
                                key={item.id}
                                className={cn(
                                    'eigen-list-item',
                                    (activeItemId === item.id || selectedIndex === adjustedIndex) &&
                                        'eigen-list-item-active',
                                    selection.isSelected(item.id) && 'eigen-list-item-selected',
                                    dragOverItemId === item.id && isValidFolderDrop(item) && 'bg-accent',
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
                                onDragLeave={() => {}}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    setDragOverItemId(null);
                                    if (isValidFolderDrop(item) && onMove) {
                                        drag.draggedItems.forEach((d) => {
                                            onMove(d, item.id);
                                        });
                                    }
                                }}
                            >
                                <TableCell>
                                    <div className="flex items-center max-w-full">
                                        <div className="relative mr-2 flex-shrink-0">
                                            {getFileIcon?.(item.mimeType, item.type, {
                                                className: 'h-4 w-4 text-muted-foreground',
                                                ...(isFolderType(item.type)
                                                    ? {
                                                          fill: 'var(--app-drive-light-color)',
                                                      }
                                                    : {}),
                                            })}
                                            {unreadPathIds?.has(item.id) && <UnreadDot />}
                                        </div>
                                        {itemHref ? (
                                            <a
                                                href={itemHref}
                                                className="truncate max-w-[calc(100%-1.5rem)]"
                                                draggable={false}
                                                tabIndex={-1}
                                                onClick={(e) => {
                                                    if (e.metaKey || e.ctrlKey) {
                                                        e.stopPropagation();
                                                        return;
                                                    }
                                                    e.preventDefault();
                                                }}
                                                onAuxClick={(e) => {
                                                    if (e.button === 1) e.stopPropagation();
                                                }}
                                            >
                                                {stripEigenExtension(item.name)}
                                            </a>
                                        ) : (
                                            <span className="truncate max-w-[calc(100%-1.5rem)]">
                                                {stripEigenExtension(item.name)}
                                            </span>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell className="hidden sm:table-cell group">
                                    <DriveShareSummary
                                        path={item}
                                        onClick={() => onShareClick?.(item)}
                                        showIconOnHover={true}
                                        ancestorBreadcrumb={ancestorBreadcrumb}
                                    />
                                </TableCell>
                                <TableCell className="hidden sm:table-cell">
                                    {item.updatedAt ? formatDateTime(item.updatedAt) : 'Unknown'}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>

            <ContextMenuAnchor contextMenu={contextMenu} className="w-48">
                {/* Section 1: Open actions */}
                {isSingleSelect &&
                    contextMenu.item &&
                    (contextMenu.item.type !== 'file' ||
                        isInlineEditable(contextMenu.item.mimeType, contextMenu.item.name)) &&
                    onItemOpen && (
                        <DropdownMenuItem
                            onClick={() => {
                                onItemOpen?.(contextMenu.item!);
                                contextMenu.close();
                            }}
                            className="flex items-center"
                        >
                            <ArrowRight className="h-4 w-4 mr-2" />
                            Open
                        </DropdownMenuItem>
                    )}
                {isSingleSelect && contextMenuItemHref && (
                    <DropdownMenuItem
                        onClick={() => {
                            window.open(contextMenuItemHref, '_blank');
                            contextMenu.close();
                        }}
                        className="flex items-center"
                    >
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Open in new tab
                    </DropdownMenuItem>
                )}
                {isSingleSelect && onQuickLook && contextMenu.item && !isFolderType(contextMenu.item.type) && (
                    <DropdownMenuItem
                        onClick={() => {
                            onQuickLook?.(contextMenu.item!);
                            contextMenu.close();
                        }}
                        className="flex items-center"
                    >
                        <Eye className="h-4 w-4 mr-2" />
                        Quick preview
                    </DropdownMenuItem>
                )}

                {/* Section 2: Download, Convert, Export, Rename */}
                {isSingleSelect &&
                    ((onDownload && contextMenu.item?.type === 'file') ||
                        (onConvert &&
                            contextMenu.item?.type === 'file' &&
                            contextMenu.item.name.toLowerCase().endsWith('.xlsx')) ||
                        ((contextMenu.item?.type === 'doc' || contextMenu.item?.type === 'slides') && onExport) ||
                        onRename) && <DropdownMenuSeparator />}
                {isSingleSelect && onDownload && contextMenu.item?.type === 'file' && (
                    <DropdownMenuItem
                        onClick={() => {
                            onDownload?.(contextMenu.item!);
                            contextMenu.close();
                        }}
                        className="flex items-center"
                    >
                        <Download className="h-4 w-4 mr-2" />
                        Download
                    </DropdownMenuItem>
                )}
                {isSingleSelect &&
                    onConvert &&
                    contextMenu.item?.type === 'file' &&
                    contextMenu.item.name.toLowerCase().endsWith('.xlsx') && (
                        <DropdownMenuItem
                            onClick={() => {
                                onConvert(contextMenu.item!, 'eigensheets');
                                contextMenu.close();
                            }}
                            className="flex items-center"
                        >
                            <Sheet className="h-4 w-4 mr-2" />
                            Convert to Sheet
                        </DropdownMenuItem>
                    )}
                {isSingleSelect &&
                    (contextMenu.item?.type === 'doc' || contextMenu.item?.type === 'slides') &&
                    onExport && (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <FileDown className="h-4 w-4 mr-2" />
                                Export
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {(contextMenu.item?.type === 'doc' ? ['docx', 'pdf', 'html'] : ['pdf', 'html']).map(
                                    (format) => (
                                        <DropdownMenuItem
                                            key={format}
                                            onClick={() => {
                                                onExport(contextMenu.item!, format);
                                                contextMenu.close();
                                            }}
                                        >
                                            Export as {format.toUpperCase()}
                                        </DropdownMenuItem>
                                    ),
                                )}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    )}
                {isSingleSelect && onRename && (
                    <DropdownMenuItem
                        onClick={() => {
                            onRename?.(contextMenu.item!);
                            contextMenu.close();
                        }}
                        className="flex items-center"
                    >
                        <Pencil className="h-4 w-4 mr-2" />
                        Rename
                    </DropdownMenuItem>
                )}

                {/* Section 3: Share */}
                {isSingleSelect && onShareClick && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <UserRoundPlus className="h-4 w-4 mr-2" />
                                Share
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                <DropdownMenuItem
                                    onClick={() => {
                                        onShareClick(contextMenu.item!);
                                        contextMenu.close();
                                    }}
                                >
                                    <UserRoundPlus className="h-4 w-4 mr-2" />
                                    Share
                                </DropdownMenuItem>
                                {onEmailCollaborators &&
                                    (contextMenu.item?.acl?.length || contextMenu.item?.visibility !== 'private') && (
                                        <DropdownMenuItem
                                            onClick={() => {
                                                onEmailCollaborators(contextMenu.item!);
                                                contextMenu.close();
                                            }}
                                        >
                                            <Mail className="h-4 w-4 mr-2" />
                                            Email collaborators
                                        </DropdownMenuItem>
                                    )}
                                <DropdownMenuItem
                                    onClick={() => {
                                        copyToClipboard(
                                            getDriveShareUrl(contextMenu.item!),
                                            'Link copied to clipboard',
                                        );
                                        contextMenu.close();
                                    }}
                                >
                                    <Link className="h-4 w-4 mr-2" />
                                    Copy link
                                </DropdownMenuItem>
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    </>
                )}

                {/* Section 4: Move to bin */}
                {allowDelete && contextItems.length > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onClick={() => {
                                onDelete?.(contextItems);
                                contextMenu.close();
                            }}
                            className="flex items-center"
                        >
                            <Trash2 className="h-4 w-4 mr-2" />
                            {isSingleSelect ? 'Move to bin' : `Move ${contextItems.length} items to bin`}
                        </DropdownMenuItem>
                    </>
                )}
            </ContextMenuAnchor>
        </div>
    );
}
