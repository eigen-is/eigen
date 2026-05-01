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
import { cn } from '@workspace/ui/lib/utils';
import {
    ArrowRight,
    ChevronLeft,
    Download,
    ExternalLink,
    Eye,
    FileDown,
    FileText,
    Link,
    Mail,
    Pencil,
    Sheet,
    Trash2,
    UserRoundPlus,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboardListNavigation } from '../../../hooks/use-keyboard-list-navigation';
import { useListDrag } from '../../../hooks/use-list-drag';
import { useListSelection } from '../../../hooks/use-list-selection';
import { ContextMenuAnchor, useContextMenu } from '../context-menu';
import { formatDownloadLabel } from '../toolbar/file-menu';
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
    isItemDisabled?: (item: DrivePath) => boolean;
    getItemHref?: (item: DrivePath) => string | undefined;
    onShareClick?: (item: DrivePath) => void;
    onDownload?: (item: DrivePath) => void;
    onDelete?: (items: DrivePath[]) => void;
    onRename?: (item: DrivePath) => void;
    onMove?: (item: DrivePath, targetItemId: string) => void;
    onConvert?: (item: DrivePath, targetType: 'eigensheets' | 'eigendoc') => void;
    onExport?: (item: DrivePath, format: string) => void;
    onQuickLook?: (item: DrivePath) => void;
    onEmailCollaborators?: (item: DrivePath) => void;
    sortFn?: (a: DrivePath, b: DrivePath) => number;
    allowDelete?: boolean;
    ancestorBreadcrumb?: DrivePath[];
    showParentRow?: boolean;
    unreadPathIds?: Set<string>;
    hideModified?: boolean;
    hideShareClick?: boolean;
    hideHeader?: boolean;
    externalSelectedIds?: Set<string>;
    // Fires whenever the internal shift/ctrl-aware selection changes — used by file pickers
    // in multi-select mode to mirror the selection without reimplementing modifier handling.
    onSelectionChange?: (items: DrivePath[]) => void;
};

export function DriveTable({
    items = [],
    currentPath,
    activeItemId,
    onItemClick,
    onItemOpen,
    getFileIcon,
    isItemDisabled,
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
    hideModified = false,
    hideShareClick = false,
    hideHeader = false,
    externalSelectedIds,
    onSelectionChange,
}: DriveTableProps) {
    const containerRef = useRef<HTMLDivElement>(null);
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
                mimeType: 'folder',
                size: 0,
                hash: null,
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

    useEffect(() => {
        onSelectionChange?.(selection.selectedItems);
    }, [selection.selectedItems, onSelectionChange]);

    const { selectedIndex, handleKeyDown } = useKeyboardListNavigation<DrivePath>({
        items: allItems,
        activeId: activeItemId,
        getId: (item) => item.id,
        onSelect: handleItemSelect,
        onQuickLook: onQuickLook ? handleQuickLook : undefined,
        containerRef,
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

    const gridCols = hideModified
        ? 'grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_10%]'
        : 'grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_10%_15%]';

    return (
        <div
            ref={containerRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="flex-1 overflow-auto relative w-full text-sm focus:outline-none"
        >
            {!hideHeader && (
                <div className={cn('grid border-b', gridCols)}>
                    <div className="text-muted-foreground h-10 px-2 flex items-center font-medium">Name</div>
                    <div className="text-muted-foreground h-10 px-2 hidden sm:flex items-center font-medium">Share</div>
                    {!hideModified && (
                        <div className="text-muted-foreground h-10 px-2 hidden sm:flex items-center font-medium">
                            Modified
                        </div>
                    )}
                </div>
            )}

            {hasParentItem && currentPath && (
                <div
                    className={cn(
                        'grid border-b transition-colors eigen-list-item',
                        gridCols,
                        (activeItemId === currentPath.parentId || selectedIndex === 0) && 'eigen-list-item-active',
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
                    <div className="px-2 py-1.5 flex items-center font-medium">
                        <ChevronLeft className="h-4 w-4 mr-2 text-muted-foreground" />
                        <span>..</span>
                    </div>
                    <div className="hidden sm:block px-2 py-1.5" />
                    {!hideModified && <div className="hidden sm:block px-2 py-1.5">-</div>}
                </div>
            )}

            {sortedItems.map((item, index) => {
                const adjustedIndex = hasParentItem ? index + 1 : index;
                const itemHref = getItemHref?.(item);
                const disabled = isItemDisabled?.(item) ?? false;

                return (
                    <div
                        key={item.id}
                        className={cn(
                            'grid border-b transition-colors eigen-list-item',
                            gridCols,
                            (activeItemId === item.id || selectedIndex === adjustedIndex) && 'eigen-list-item-active',
                            (selection.isSelected(item.id) || externalSelectedIds?.has(item.id)) &&
                                'eigen-list-item-selected',
                            dragOverItemId === item.id && isValidFolderDrop(item) && 'bg-accent',
                            disabled && 'opacity-40 pointer-events-none',
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
                        <div className="px-2 py-1.5 flex items-center min-w-0">
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
                                    className="truncate"
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
                                <span className="truncate">{stripEigenExtension(item.name)}</span>
                            )}
                        </div>
                        <div className="hidden sm:flex items-center px-2 py-1.5 group">
                            <DriveShareSummary
                                path={item}
                                onClick={hideShareClick ? undefined : () => onShareClick?.(item)}
                                showIconOnHover={!hideShareClick}
                                ancestorBreadcrumb={ancestorBreadcrumb}
                            />
                        </div>
                        {!hideModified && (
                            <div className="hidden sm:flex items-center px-2 py-1.5 whitespace-nowrap">
                                {item.updatedAt ? formatDateTime(item.updatedAt) : 'Unknown'}
                            </div>
                        )}
                    </div>
                );
            })}

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
                            (contextMenu.item.name.toLowerCase().endsWith('.xlsx') ||
                                contextMenu.item.name.toLowerCase().endsWith('.docx'))) ||
                        ((contextMenu.item?.type === 'doc' ||
                            contextMenu.item?.type === 'slides' ||
                            contextMenu.item?.type === 'sheets') &&
                            onExport) ||
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
                    onConvert &&
                    contextMenu.item?.type === 'file' &&
                    contextMenu.item.name.toLowerCase().endsWith('.docx') && (
                        <DropdownMenuItem
                            onClick={() => {
                                onConvert(contextMenu.item!, 'eigendoc');
                                contextMenu.close();
                            }}
                            className="flex items-center"
                        >
                            <FileText className="h-4 w-4 mr-2" />
                            Convert to Document
                        </DropdownMenuItem>
                    )}
                {isSingleSelect &&
                    (contextMenu.item?.type === 'doc' ||
                        contextMenu.item?.type === 'slides' ||
                        contextMenu.item?.type === 'sheets') &&
                    onExport && (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <FileDown className="h-4 w-4 mr-2" />
                                Download
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {(contextMenu.item?.type === 'doc'
                                    ? ['docx', 'pdf', 'html']
                                    : contextMenu.item?.type === 'sheets'
                                      ? ['xlsx', 'pdf', 'html']
                                      : ['pdf', 'html']
                                ).map((format) => (
                                    <DropdownMenuItem
                                        key={format}
                                        onClick={() => {
                                            onExport(contextMenu.item!, format);
                                            contextMenu.close();
                                        }}
                                    >
                                        {formatDownloadLabel(format)}
                                    </DropdownMenuItem>
                                ))}
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
