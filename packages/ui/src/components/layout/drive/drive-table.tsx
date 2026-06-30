import { formatDateTime } from '@workspace/lib/date';
import { defaultDriveSort } from '@workspace/lib/drive';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import { Copy, CopyPlus, FolderInput, MoreVertical, Trash2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboardListNavigation } from '../../../hooks/use-keyboard-list-navigation';
import { useListDrag } from '../../../hooks/use-list-drag';
import { useListSelection } from '../../../hooks/use-list-selection';
import { ContextMenuAnchor, useContextMenu } from '../context-menu';
import { UnreadDot } from '../unread-dot';
import { UserAvatar } from '../user-avatar';
import { DriveItemMenuItems } from './drive-item-menu';
import { DriveShareSummary } from './drive-share-summary';
import { getFilePresentation } from './file-presentation';

export type DriveTableProps = {
    items: DrivePath[];
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
    onMoveTo?: (items: DrivePath[]) => void;
    onCopyTo?: (items: DrivePath[]) => void;
    onDuplicate?: (items: DrivePath[]) => void;
    onConvert?: (item: DrivePath, targetType: 'eigensheets' | 'eigendoc') => void;
    onExport?: (item: DrivePath, format: string) => void;
    onQuickLook?: (item: DrivePath) => void;
    onEmailCollaborators?: (item: DrivePath) => void;
    sortFn?: (a: DrivePath, b: DrivePath) => number;
    allowDelete?: boolean;
    ancestorBreadcrumb?: DrivePath[];
    unreadPathIds?: Set<string>;
    hideModified?: boolean;
    hideOwner?: boolean;
    hideShareClick?: boolean;
    hideHeader?: boolean;
    externalSelectedIds?: Set<string>;
    // Fires whenever the internal shift/ctrl-aware selection changes — used by file pickers
    // in multi-select mode to mirror the selection without reimplementing modifier handling.
    onSelectionChange?: (items: DrivePath[]) => void;
};

export function DriveTable({
    items = [],
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
    onMoveTo,
    onCopyTo,
    onDuplicate,
    onConvert,
    onExport,
    onQuickLook,
    onEmailCollaborators,
    sortFn = defaultDriveSort,
    allowDelete = false,
    ancestorBreadcrumb,
    unreadPathIds,
    hideModified = false,
    hideOwner = false,
    hideShareClick = false,
    hideHeader = false,
    externalSelectedIds,
    onSelectionChange,
}: DriveTableProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);

    const sortedItems = useMemo(() => {
        return [...items].sort(sortFn);
    }, [items, sortFn]);

    const handleItemSelect = useCallback(
        (id: string) => {
            const item = sortedItems.find((i) => i.id === id);
            if (item) onItemClick?.(item);
        },
        [sortedItems, onItemClick],
    );

    const handleQuickLook = useCallback(
        (id: string) => {
            if (!onQuickLook) return;
            const item = sortedItems.find((i) => i.id === id);
            if (item) onQuickLook(item);
        },
        [sortedItems, onQuickLook],
    );

    const selection = useListSelection({ items: sortedItems, getId: (item) => item.id });

    useEffect(() => {
        onSelectionChange?.(selection.selectedItems);
    }, [selection.selectedItems, onSelectionChange]);

    const { selectedIndex, handleKeyDown } = useKeyboardListNavigation<DrivePath>({
        items: sortedItems,
        activeId: activeItemId,
        getId: (item) => item.id,
        onSelect: handleItemSelect,
        onQuickLook: onQuickLook ? handleQuickLook : undefined,
        containerRef,
        shouldNotify: () => !!activeItemId,
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

    const openContextMenuFromButton = (button: HTMLElement, item: DrivePath) => {
        if (!selection.isSelected(item.id)) {
            selection.select(item.id);
        }
        const rect = button.getBoundingClientRect();
        contextMenu.openAt(item, rect.right, rect.bottom);
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

    const gridCols =
        hideModified && hideOwner
            ? 'grid-cols-[minmax(0,1fr)] @[800px]:grid-cols-[minmax(0,1fr)_10%_40px]'
            : hideModified
              ? 'grid-cols-[minmax(0,1fr)] @[800px]:grid-cols-[minmax(0,1fr)_8%_10%_40px]'
              : hideOwner
                ? 'grid-cols-[minmax(0,1fr)] @[600px]:grid-cols-[minmax(0,1fr)_15%] @[800px]:grid-cols-[minmax(0,1fr)_10%_15%_40px]'
                : 'grid-cols-[minmax(0,1fr)] @[600px]:grid-cols-[minmax(0,1fr)_15%] @[800px]:grid-cols-[minmax(0,1fr)_8%_10%_15%_40px]';

    return (
        <div
            ref={containerRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="@container flex-1 overflow-auto relative w-full text-sm focus:outline-none"
        >
            {!hideHeader && (
                <div className={cn('grid border-b app-gutter-x', gridCols)}>
                    <div className="eigen-section-label h-10 pr-2 flex items-center">Name</div>
                    {!hideOwner && (
                        <div className="eigen-section-label h-10 px-2 hidden @[800px]:flex items-center justify-center">
                            Owner
                        </div>
                    )}
                    <div className="eigen-section-label h-10 px-2 hidden @[800px]:flex items-center justify-center whitespace-nowrap">
                        Shared with
                    </div>
                    {!hideModified && (
                        <div className="eigen-section-label h-10 pl-2 pr-4 hidden @[600px]:flex items-center justify-end">
                            Modified
                        </div>
                    )}
                    <div className="hidden @[800px]:block" />
                </div>
            )}

            {sortedItems.map((item, index) => {
                const itemHref = getItemHref?.(item);
                const disabled = isItemDisabled?.(item) ?? false;
                const presentation = getFilePresentation(item.mimeType, item.type);

                return (
                    <div
                        key={item.id}
                        className={cn(
                            'grid border-b transition-colors eigen-list-item app-gutter-x',
                            gridCols,
                            (activeItemId === item.id || selectedIndex === index) && 'eigen-list-item-active',
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
                        <div className="pr-2 py-1.5 flex items-center min-w-0">
                            <div className="relative mr-2 flex-shrink-0">
                                {getFileIcon?.(item.mimeType, item.type, {
                                    className: 'h-4 w-4',
                                    style: { color: presentation.colorVar, fill: presentation.fillColorVar },
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
                        {!hideOwner && (
                            <div className="hidden @[800px]:flex items-center justify-center px-2 py-1.5">
                                <div className="-my-0.5">
                                    <UserAvatar userId={item.ownerId} size="sm" tooltip />
                                </div>
                            </div>
                        )}
                        <div className="hidden @[800px]:flex items-center justify-center px-2 py-1.5 group">
                            <DriveShareSummary
                                path={item}
                                onClick={hideShareClick ? undefined : () => onShareClick?.(item)}
                                showIconOnHover={!hideShareClick}
                                ancestorBreadcrumb={ancestorBreadcrumb}
                            />
                        </div>
                        {!hideModified && (
                            <div className="hidden @[600px]:flex items-center justify-end pl-2 pr-4 py-1.5 whitespace-nowrap text-xs text-muted-foreground">
                                {item.updatedAt ? formatDateTime(item.updatedAt) : 'Unknown'}
                            </div>
                        )}
                        <div className="hidden @[800px]:flex items-center justify-center py-1.5">
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    openContextMenuFromButton(e.currentTarget, item);
                                }}
                                className="h-7 w-7 rounded hover:bg-accent flex items-center justify-center text-muted-foreground"
                                aria-label="More actions"
                            >
                                <MoreVertical className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                );
            })}

            <ContextMenuAnchor contextMenu={contextMenu} className="w-48">
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
        </div>
    );
}
