// The grid view of a Drive listing: virtualized tiles in as many columns as fit, with the same
// selection, keys and context menu as the table. DriveList draws it in grid mode.

import { useVirtualizer } from '@tanstack/react-virtual';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useRef } from 'react';
import { useElementSize } from '../../hooks/use-element-size';
import { useLongPress } from '../../hooks/use-long-press';
import { DriveItemContextMenu } from './drive-item-context-menu';
import type { DriveViewProps } from './drive-table';
import { DriveTile } from './drive-tile';
import { useDriveItemController } from './use-drive-item-controller';

const TILE_MIN_WIDTH = 160;
// A first guess only: each row of tiles is measured, as its height follows the column width.
const TILE_ROW_HEIGHT = 168;

export function DriveGrid({
    items = [],
    activeItemId,
    onItemClick,
    isItemDisabled,
    getItemHref,
    onQuickLook,
    actions,
    selection,
    onSelectionChange,
    ownActions,
    unreadPathIds,
}: DriveViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [setContainer, { width }] = useElementSize(containerRef);
    // Zero until the grid is measured. The initial scroll and scrollToIndex wait for a real column count.
    const columns = width === 0 ? 0 : Math.max(1, Math.floor(width / TILE_MIN_WIDTH));

    const rowCount = Math.ceil(items.length / Math.max(columns, 1));

    const virtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => containerRef.current,
        estimateSize: () => TILE_ROW_HEIGHT,
        overscan: 6,
        // The tiles spacer is the scroller's first child, so scrollMargin stays 0.
    });

    const controller = useDriveItemController({
        items,
        activeItemId,
        columns: Math.max(columns, 1),
        scrollToIndex: columns ? (i, opts) => virtualizer.scrollToIndex(Math.floor(i / columns), opts) : undefined,
        containerRef,
        selection,
        onItemClick,
        onQuickLook,
        onSelectionChange,
        actions,
    });

    // One long-press for the whole grid: each tile binds it to its item, and a disabled tile doesn't.
    const longPress = useLongPress<DrivePath>((item, x, y) => controller.openContextMenuAt(item, x, y));

    return (
        <div
            ref={setContainer}
            tabIndex={0}
            onKeyDown={controller.handleKeyDown}
            role="grid"
            aria-rowcount={rowCount}
            className="@container flex-1 overflow-auto relative w-full focus:outline-none app-gutter-x py-2"
        >
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vrow) => {
                    const cols = Math.max(columns, 1);
                    const start = vrow.index * cols;
                    const rowItems = items.slice(start, start + cols);
                    return (
                        <div
                            key={vrow.key}
                            data-index={vrow.index}
                            ref={virtualizer.measureElement}
                            className="absolute inset-x-0 top-0 grid gap-3 pb-3"
                            style={{
                                transform: `translateY(${vrow.start}px)`,
                                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                            }}
                        >
                            {rowItems.map((item, i) => {
                                const index = start + i;
                                return (
                                    <DriveTile
                                        key={item.id}
                                        item={item}
                                        controller={controller}
                                        longPressBind={longPress.bind}
                                        isActive={activeItemId === item.id}
                                        isCursor={controller.selectedIndex === index}
                                        isSelected={controller.selection.isSelected(item.id)}
                                        disabled={isItemDisabled?.(item) ?? false}
                                        getItemHref={getItemHref}
                                        onItemClick={onItemClick}
                                        unreadPathIds={unreadPathIds}
                                    />
                                );
                            })}
                        </div>
                    );
                })}
            </div>

            <DriveItemContextMenu controller={controller} items={items} actions={actions} ownActions={ownActions} />
        </div>
    );
}
