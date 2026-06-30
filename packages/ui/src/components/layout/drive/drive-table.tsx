import { useVirtualizer } from '@tanstack/react-virtual';
import { defaultDriveSort } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types';
import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DriveItemContextMenu } from './drive-item-context-menu';
import { DriveRow } from './drive-row';
import { useDriveItemController } from './use-drive-item-controller';

// Shared base for the drive views (table + grid): data, callbacks and selection inputs,
// minus the table-only column flags. DriveGrid consumes this directly.
export type DriveViewProps = {
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
    unreadPathIds?: Set<string>;
    externalSelectedIds?: Set<string>;
    // Fires whenever the internal shift/ctrl-aware selection changes — used by file pickers
    // in multi-select mode to mirror the selection without reimplementing modifier handling.
    onSelectionChange?: (items: DrivePath[]) => void;
};

// Table view adds the column-layout flags the grid has no concept of.
export type DriveTableProps = DriveViewProps & {
    hideModified?: boolean;
    hideOwner?: boolean;
    hideShareClick?: boolean;
    hideHeader?: boolean;
    ancestorBreadcrumb?: DrivePath[];
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
    const listRef = useRef<HTMLDivElement>(null);
    const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);

    const sortedItems = useMemo(() => {
        return [...items].sort(sortFn);
    }, [items, sortFn]);

    // Initial estimate only — every row is measured (measureElement), so the authoritative
    // height comes from the DOM. A fixed size won't do: the ⋮ column makes wide rows ~41px
    // while the name-only picker layout is ~33px, and the breakpoint is container-driven.
    const ROW_HEIGHT = 41;
    const virtualizer = useVirtualizer({
        count: sortedItems.length,
        getScrollElement: () => containerRef.current,
        estimateSize: () => ROW_HEIGHT,
        // Key the measurement cache by id so a re-sort moves cached heights with their rows.
        getItemKey: (index) => sortedItems[index].id,
        overscan: 12,
        // Offset of the virtualized list within the scroller — measured on the list
        // wrapper, NOT the sticky header (a stuck header's offsetTop equals scrollTop,
        // which would grow scrollMargin in lockstep with scroll and pin the window).
        scrollMargin: listRef.current?.offsetTop ?? 0,
    });

    const controller = useDriveItemController({
        items: sortedItems,
        activeItemId,
        containerRef,
        scrollToIndex: virtualizer.scrollToIndex,
        onItemClick,
        onQuickLook,
        onSelectionChange,
    });

    // A deep-linked active row can be windowed out of the DOM on mount — scroll it in once.
    // Snapshot the id at mount so only a deep-link recenters, not a later in-session select.
    const initialActiveId = useRef(activeItemId);
    const didInitialScroll = useRef(false);
    useEffect(() => {
        if (didInitialScroll.current || !initialActiveId.current) return;
        const idx = sortedItems.findIndex((i) => i.id === initialActiveId.current);
        if (idx >= 0) {
            virtualizer.scrollToIndex(idx, { align: 'center' });
            didInitialScroll.current = true;
        }
    }, [sortedItems, virtualizer]);

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
            onKeyDown={controller.handleKeyDown}
            role="grid"
            aria-rowcount={sortedItems.length}
            className="@container flex-1 overflow-auto relative w-full text-sm focus:outline-none"
        >
            {!hideHeader && (
                <div className={cn('grid border-b app-gutter-x sticky top-0 z-10 bg-background', gridCols)}>
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

            <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vi) => {
                    const item = sortedItems[vi.index];
                    return (
                        <div
                            key={item.id}
                            data-index={vi.index}
                            ref={virtualizer.measureElement}
                            className="absolute inset-x-0 top-0"
                            style={{ transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)` }}
                        >
                            <DriveRow
                                item={item}
                                index={vi.index}
                                gridCols={gridCols}
                                controller={controller}
                                isActive={activeItemId === item.id || controller.selectedIndex === vi.index}
                                isSelected={
                                    controller.selection.isSelected(item.id) || !!externalSelectedIds?.has(item.id)
                                }
                                isDragOver={dragOverItemId === item.id}
                                disabled={isItemDisabled?.(item) ?? false}
                                getFileIcon={getFileIcon}
                                getItemHref={getItemHref}
                                onItemClick={onItemClick}
                                onShareClick={onShareClick}
                                onMove={onMove}
                                setDragOverItemId={setDragOverItemId}
                                hideOwner={hideOwner}
                                hideModified={hideModified}
                                hideShareClick={hideShareClick}
                                ancestorBreadcrumb={ancestorBreadcrumb}
                                unreadPathIds={unreadPathIds}
                            />
                        </div>
                    );
                })}
            </div>

            <DriveItemContextMenu
                controller={controller}
                getItemHref={getItemHref}
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
        </div>
    );
}
