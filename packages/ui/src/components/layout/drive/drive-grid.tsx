import { useVirtualizer } from '@tanstack/react-virtual';
import type { DrivePath } from '@workspace/lib/types';
import { useEffect, useRef, useState } from 'react';
import { useLongPress } from '../../../hooks/use-long-press';
import { DriveItemContextMenu } from './drive-item-context-menu';
import type { DriveViewProps } from './drive-table';
import { DriveTile } from './drive-tile';
import { useDriveItemController } from './use-drive-item-controller';

const TILE_MIN_WIDTH = 160;
// Estimate only — tile rows are measured; real height tracks column width (aspect-[4/3] thumbs).
const TILE_ROW_HEIGHT = 168;

export type DriveGridProps = DriveViewProps;

export function DriveGrid({
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
    selection,
    onSelectionChange,
    contextMenuItems,
    unreadPathIds,
}: DriveGridProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    // 0 = not yet measured; the initial scroll and scrollToIndex wait for a real column count.
    const [columns, setColumns] = useState(0);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const measure = () => setColumns(Math.max(1, Math.floor(el.clientWidth / TILE_MIN_WIDTH)));
        const obs = new ResizeObserver(measure);
        obs.observe(el);
        measure();
        return () => obs.disconnect();
    }, []);

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
        onMove,
        onSelectionChange,
    });

    // One long-press instance for the whole grid — tiles spread bind(item); disabled tiles skip it.
    const longPress = useLongPress<DrivePath>((item, x, y) => controller.openContextMenuAt(item, x, y));

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
                                        isActive={activeItemId === item.id || controller.selectedIndex === index}
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
