import { useVirtualizer } from '@tanstack/react-virtual';
import { defaultDriveSort } from '@workspace/lib/drive';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DriveItemContextMenu } from './drive-item-context-menu';
import type { DriveViewProps } from './drive-table';
import { DriveTile } from './drive-tile';
import { useDriveItemController } from './use-drive-item-controller';

const TILE_MIN_WIDTH = 160;
// Initial estimate only — each tile-row is measured (measureElement), so the live height
// wins. A single fixed value can't stay exact: the tile's aspect-[4/3] thumbnail makes its
// height a function of column width (≈width×3/4 + the 36px name row + the 12px row gap),
// which moves with the container width, not just at breakpoints. 168 = the floor case at
// TILE_MIN_WIDTH (120 thumb + 36 name + 12 gap).
const TILE_ROW_HEIGHT = 168;

export type DriveGridProps = DriveViewProps;

export function DriveGrid({
    items = [],
    activeItemId,
    sortFn = defaultDriveSort,
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
    onSelectionChange,
}: DriveGridProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const obs = new ResizeObserver(() => setWidth(el.clientWidth));
        obs.observe(el);
        setWidth(el.clientWidth);
        return () => obs.disconnect();
    }, []);

    const sortedItems = useMemo(() => [...items].sort(sortFn), [items, sortFn]);
    const columns = Math.max(1, Math.floor((width || TILE_MIN_WIDTH) / TILE_MIN_WIDTH));
    const rowCount = Math.ceil(sortedItems.length / columns);

    const virtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => containerRef.current,
        estimateSize: () => TILE_ROW_HEIGHT,
        overscan: 6,
        // No sticky header sits above the tiles spacer (it is the scroller's first child), so
        // the virtualized area starts at the scroll origin — scrollMargin stays 0.
    });

    const controller = useDriveItemController({
        items: sortedItems,
        activeItemId,
        columns,
        scrollToIndex: (i) => virtualizer.scrollToIndex(Math.floor(i / columns)),
        containerRef,
        onItemClick,
        onQuickLook,
        onMove,
        onSelectionChange,
    });

    // A deep-linked active tile can be windowed out of the DOM on mount — scroll it in once.
    // Snapshot the id at mount so only a deep-link recenters, not a later in-session select.
    const initialActiveId = useRef(activeItemId);
    const didInitialScroll = useRef(false);
    useEffect(() => {
        // Wait for a measured width so `columns` is real — the 0->1 default would make
        // scrollToIndex(idx / columns) overshoot on a warm mount (e.g. toggling list->grid with an active item).
        if (didInitialScroll.current || !initialActiveId.current || !width) return;
        const idx = sortedItems.findIndex((i) => i.id === initialActiveId.current);
        if (idx >= 0) {
            virtualizer.scrollToIndex(Math.floor(idx / columns), { align: 'center' });
            didInitialScroll.current = true;
        }
    }, [sortedItems, columns, virtualizer, width]);

    return (
        <div
            ref={containerRef}
            tabIndex={0}
            onKeyDown={controller.handleKeyDown}
            role="grid"
            aria-rowcount={rowCount}
            className="@container flex-1 overflow-auto relative w-full focus:outline-none app-gutter-x py-2"
        >
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vrow) => {
                    const start = vrow.index * columns;
                    const rowItems = sortedItems.slice(start, start + columns);
                    return (
                        <div
                            key={vrow.key}
                            data-index={vrow.index}
                            ref={virtualizer.measureElement}
                            className="absolute inset-x-0 top-0 grid gap-3 pb-3"
                            style={{
                                transform: `translateY(${vrow.start}px)`,
                                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                            }}
                        >
                            {rowItems.map((item, i) => {
                                const index = start + i;
                                return (
                                    <DriveTile
                                        key={item.id}
                                        item={item}
                                        isActive={activeItemId === item.id || controller.selectedIndex === index}
                                        isSelected={controller.selection.isSelected(item.id)}
                                        disabled={isItemDisabled?.(item) ?? false}
                                        href={getItemHref?.(item)}
                                        onClick={(e) => {
                                            controller.selection.handleItemClick(item.id, e);
                                            if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onItemClick?.(item);
                                        }}
                                        onContextMenu={(e) => controller.handleContextMenu(e, item)}
                                        onMenuButton={(btn) => controller.openContextMenuFromButton(btn, item)}
                                        dragProps={controller.drag.getDragProps(item)}
                                        dropProps={controller.getDropProps(item)}
                                        isDropTarget={
                                            controller.dragOverItemId === item.id && controller.isValidFolderDrop(item)
                                        }
                                    />
                                );
                            })}
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
