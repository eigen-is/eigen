import { useVirtualizer } from '@tanstack/react-virtual';
import { useIsCoarsePointer } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types';
import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';
import { useRef } from 'react';
import type { UseListSelectionReturn } from '../../../hooks/use-list-selection';
import { DriveItemContextMenu } from './drive-item-context-menu';
import { DriveRow } from './drive-row';
import { useDriveItemController } from './use-drive-item-controller';

// Shared base for the drive views (table + grid): data, callbacks and selection inputs,
// minus the table-only column flags. DriveGrid consumes this directly.
export type DriveViewProps = {
    // Already sorted by the caller — the views render and navigate them as-is.
    items: DrivePath[];
    activeItemId?: string;
    onItemClick?: (item: DrivePath) => void;
    onItemOpen?: (item: DrivePath) => void;
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
    allowDelete?: boolean;
    unreadPathIds?: Set<string>;
    // Selection lifted by the caller (DriveList) so it survives list/grid toggles.
    selection?: UseListSelectionReturn<DrivePath>;
    // Fires whenever the internal shift/ctrl-aware selection changes — used by file pickers
    // in multi-select mode to mirror the selection without reimplementing modifier handling.
    onSelectionChange?: (items: DrivePath[]) => void;
    // Replaces the default context-menu body — used by listings with their own actions (trash).
    contextMenuItems?: (items: DrivePath[], close: () => void) => React.ReactNode;
};

// Table view adds the column-layout flags the grid has no concept of.
export type DriveTableProps = DriveViewProps & {
    hideModified?: boolean;
    hideOwner?: boolean;
    hideShared?: boolean;
    hideShareClick?: boolean;
    hideHeader?: boolean;
    dateLabel?: string;
    getItemDate?: (item: DrivePath) => Date | null;
    ancestorBreadcrumb?: DrivePath[];
    externalSelectedIds?: Set<string>;
};

// Static permutations so Tailwind's JIT sees every class; keyed by the visible optional columns.
const GRID_COLS_800: Record<string, string> = {
    'owner-shared-modified': '@[800px]:grid-cols-[minmax(0,1fr)_8%_10%_15%_40px]',
    'owner-shared': '@[800px]:grid-cols-[minmax(0,1fr)_8%_10%_40px]',
    'owner-modified': '@[800px]:grid-cols-[minmax(0,1fr)_8%_15%_40px]',
    'shared-modified': '@[800px]:grid-cols-[minmax(0,1fr)_10%_15%_40px]',
    owner: '@[800px]:grid-cols-[minmax(0,1fr)_8%_40px]',
    shared: '@[800px]:grid-cols-[minmax(0,1fr)_10%_40px]',
    modified: '@[800px]:grid-cols-[minmax(0,1fr)_15%_40px]',
    '': '@[800px]:grid-cols-[minmax(0,1fr)_40px]',
};

export function DriveTable({
    items = [],
    activeItemId,
    onItemClick,
    onItemOpen,
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
    allowDelete = false,
    ancestorBreadcrumb,
    unreadPathIds,
    hideModified = false,
    hideOwner = false,
    hideShared = false,
    hideShareClick = false,
    hideHeader = false,
    dateLabel = 'Modified',
    getItemDate,
    selection,
    externalSelectedIds,
    onSelectionChange,
    contextMenuItems,
}: DriveTableProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Estimate only — every row is measured, since row height varies with the container-driven layout.
    const ROW_HEIGHT = 41;
    const virtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => containerRef.current,
        estimateSize: () => ROW_HEIGHT,
        // Key the measurement cache by id so a re-sort moves cached heights with their rows.
        getItemKey: (index) => items[index].id,
        overscan: 12,
        // List offset within the scroller — measured on the list wrapper, not the sticky header.
        scrollMargin: listRef.current?.offsetTop ?? 0,
    });

    const controller = useDriveItemController({
        items,
        activeItemId,
        containerRef,
        scrollToIndex: virtualizer.scrollToIndex,
        selection,
        onItemClick,
        onQuickLook,
        onMove,
        onSelectionChange,
    });

    // On touch devices the row ⋮ has no hover/right-click affordance, so the 40px kebab
    // column renders at every container width; on fine pointers the classes are unchanged.
    const coarse = useIsCoarsePointer();
    const colsKey = [!hideOwner && 'owner', !hideShared && 'shared', !hideModified && 'modified']
        .filter(Boolean)
        .join('-');
    const gridCols = cn(
        coarse ? 'grid-cols-[minmax(0,1fr)_40px]' : 'grid-cols-[minmax(0,1fr)]',
        !hideModified &&
            (coarse ? '@[600px]:grid-cols-[minmax(0,1fr)_15%_40px]' : '@[600px]:grid-cols-[minmax(0,1fr)_15%]'),
        GRID_COLS_800[colsKey],
    );

    return (
        <div
            ref={containerRef}
            tabIndex={0}
            onKeyDown={controller.handleKeyDown}
            role="grid"
            aria-rowcount={items.length}
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
                    {!hideShared && (
                        <div className="eigen-section-label h-10 px-2 hidden @[800px]:flex items-center justify-center whitespace-nowrap">
                            Shared with
                        </div>
                    )}
                    {!hideModified && (
                        <div className="eigen-section-label h-10 pl-2 pr-4 hidden @[600px]:flex items-center justify-end">
                            {dateLabel}
                        </div>
                    )}
                    <div className={coarse ? 'block' : 'hidden @[800px]:block'} />
                </div>
            )}

            <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vi) => {
                    const item = items[vi.index];
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
                                coarse={coarse}
                                controller={controller}
                                isActive={activeItemId === item.id || controller.selectedIndex === vi.index}
                                isSelected={
                                    controller.selection.isSelected(item.id) || !!externalSelectedIds?.has(item.id)
                                }
                                disabled={isItemDisabled?.(item) ?? false}
                                getItemHref={getItemHref}
                                onItemClick={onItemClick}
                                onShareClick={onShareClick}
                                hideOwner={hideOwner}
                                hideShared={hideShared}
                                hideModified={hideModified}
                                hideShareClick={hideShareClick}
                                getItemDate={getItemDate}
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
                renderItems={contextMenuItems}
            />
        </div>
    );
}
