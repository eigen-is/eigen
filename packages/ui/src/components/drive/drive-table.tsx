// The list view of a Drive listing: a virtualized table with sortable column headers, rows and their
// context menu. DriveList draws it in list mode, and the pickers draw it bare, without actions. It also
// holds the shared props of both listing views and the sort rule the grid's sort menu reuses.

import { useVirtualizer } from '@tanstack/react-virtual';
import { useDriveViewPreferences } from '@workspace/lib/drive';
import { useIsCoarsePointer } from '@workspace/lib/media';
import type { PaletteSelectionAction } from '@workspace/lib/types/command-palette';
import type { DrivePath, DriveSortDir, DriveSortKey } from '@workspace/lib/types/drive';
import { nextSortDir, SortHeader, SortHeaderRow } from '@workspace/ui/components/sort-header';
import { cn } from '@workspace/ui/lib/utils';
import { useRef } from 'react';
import type { UseListSelectionReturn } from '../../hooks/use-list-selection';
import { useLongPress } from '../../hooks/use-long-press';
import type { DriveActionRunner } from './drive-action-runner';
import { DriveItemContextMenu } from './drive-item-context-menu';
import { DriveRow } from './drive-row';
import { useDriveItemController } from './use-drive-item-controller';

// Re-selecting the active field flips the direction; switching field uses that field's default. The
// grid's sort menu follows the same rule through nextDriveSort.
const DEFAULT_DIR: Record<DriveSortKey, DriveSortDir> = { name: 'asc', modified: 'desc', size: 'desc' };

export function nextDriveSort(key: DriveSortKey, sortKey: DriveSortKey, sortDir: DriveSortDir): DriveSortDir {
    return nextSortDir(key, sortKey, sortDir, DEFAULT_DIR).dir;
}

// The props both listing views take, the table's column flags aside. DriveGrid takes exactly these.
export type DriveViewProps = {
    // Already sorted by the caller: the views render and navigate them in this order.
    items: DrivePath[];
    activeItemId?: string;
    onItemClick?: (item: DrivePath) => void;
    isItemDisabled?: (item: DrivePath) => boolean;
    getItemHref?: (item: DrivePath) => string | undefined;
    onQuickLook?: (item: DrivePath) => void;
    // What the rows' menus, keys and drops do. Absent in a picker.
    actions?: DriveActionRunner;
    unreadPathIds?: ReadonlySet<string>;
    // Held by the caller, such as DriveList, so the selection survives a switch between list and grid.
    selection?: UseListSelectionReturn<DrivePath>;
    // Called on every change of the selection, Shift and Ctrl clicks included. A multi-select picker
    // mirrors the selection through it.
    onSelectionChange?: (items: DrivePath[]) => void;
    // The rows of a listing with actions of its own, such as Trash, which its rows' menu draws instead.
    ownActions?: (items: readonly DrivePath[]) => PaletteSelectionAction[];
};

// Table view adds the column-layout flags the grid has no concept of.
export type DriveTableProps = DriveViewProps & {
    hideModified?: boolean;
    hideOwner?: boolean;
    hideShared?: boolean;
    hideShareClick?: boolean;
    hideHeader?: boolean;
    // Drops the ⋮ column and its grid track at every pointer type, for a picker such as DriveBrowser,
    // whose rows have no actions.
    hideActions?: boolean;
    dateLabel?: string;
    getItemDate?: (item: DrivePath) => Date | null;
    ancestorBreadcrumb?: DrivePath[];
    externalSelectedIds?: ReadonlySet<string>;
    // A controlled sort: a header click calls onSortChange instead of writing the shared view
    // preference. A picker passes it, so its sort stays inside the dialog.
    sort?: { key: DriveSortKey; dir: DriveSortDir };
    onSortChange?: (sort: { key: DriveSortKey; dir: DriveSortDir }) => void;
};

// Every combination is written out, so Tailwind finds each class in the source. The key names the
// optional columns that show. Size always shows from 800px on, right before Modified, so every
// combination carries a 10% track for it.
const GRID_COLS_800: Record<string, string> = {
    'owner-shared-modified': '@[800px]:grid-cols-[minmax(0,1fr)_8%_10%_10%_15%_40px]',
    'owner-shared': '@[800px]:grid-cols-[minmax(0,1fr)_8%_10%_10%_40px]',
    'owner-modified': '@[800px]:grid-cols-[minmax(0,1fr)_8%_10%_15%_40px]',
    'shared-modified': '@[800px]:grid-cols-[minmax(0,1fr)_10%_10%_15%_40px]',
    owner: '@[800px]:grid-cols-[minmax(0,1fr)_8%_10%_40px]',
    shared: '@[800px]:grid-cols-[minmax(0,1fr)_10%_10%_40px]',
    modified: '@[800px]:grid-cols-[minmax(0,1fr)_10%_15%_40px]',
    '': '@[800px]:grid-cols-[minmax(0,1fr)_10%_40px]',
};

// The same combinations without the 40px track of the ⋮ column, for a picker's hideActions.
const GRID_COLS_800_NO_ACTIONS: Record<string, string> = {
    'owner-shared-modified': '@[800px]:grid-cols-[minmax(0,1fr)_8%_10%_10%_15%]',
    'owner-shared': '@[800px]:grid-cols-[minmax(0,1fr)_8%_10%_10%]',
    'owner-modified': '@[800px]:grid-cols-[minmax(0,1fr)_8%_10%_15%]',
    'shared-modified': '@[800px]:grid-cols-[minmax(0,1fr)_10%_10%_15%]',
    owner: '@[800px]:grid-cols-[minmax(0,1fr)_8%_10%]',
    shared: '@[800px]:grid-cols-[minmax(0,1fr)_10%_10%]',
    modified: '@[800px]:grid-cols-[minmax(0,1fr)_10%_15%]',
    '': '@[800px]:grid-cols-[minmax(0,1fr)_10%]',
};

export function DriveTable({
    items = [],
    activeItemId,
    onItemClick,
    isItemDisabled,
    getItemHref,
    onQuickLook,
    actions,
    ancestorBreadcrumb,
    unreadPathIds,
    hideModified = false,
    hideOwner = false,
    hideShared = false,
    hideShareClick = false,
    hideHeader = false,
    hideActions = false,
    dateLabel = 'Modified',
    getItemDate,
    selection,
    externalSelectedIds,
    onSelectionChange,
    ownActions,
    sort,
    onSortChange,
}: DriveTableProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // By default the sort is the shared view preference, which a header click writes as the grid's
    // sort menu does, so every listing sorts alike. A picker passes sort and onSortChange instead, and
    // its clicks never write the preference.
    const prefs = useDriveViewPreferences();
    const sortKey = sort?.key ?? prefs.sortKey;
    const sortDir = sort?.dir ?? prefs.sortDir;
    const onSortHeader = (key: DriveSortKey) => {
        const dir = nextDriveSort(key, sortKey, sortDir);
        if (sort) onSortChange?.({ key, dir });
        else prefs.setSort(key, dir);
    };

    // A first guess only: every row is measured, as its height follows the container's width.
    const ROW_HEIGHT = 41;
    const virtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => containerRef.current,
        estimateSize: () => ROW_HEIGHT,
        // Key the measurement cache by id so a re-sort moves cached heights with their rows.
        getItemKey: (index) => items[index].id,
        overscan: 12,
        // The list's offset in the scroller, measured on the list itself rather than the sticky header.
        scrollMargin: listRef.current?.offsetTop ?? 0,
        // That offset is the sticky header over the view's top, so a row scrolled into view stops below it.
        scrollPaddingStart: listRef.current?.offsetTop ?? 0,
    });

    const controller = useDriveItemController({
        items,
        activeItemId,
        containerRef,
        scrollToIndex: virtualizer.scrollToIndex,
        selection,
        onItemClick,
        onQuickLook,
        onSelectionChange,
        actions,
        hasMenu: !hideActions,
    });

    // One long-press for the whole list: each row binds it to its item, and a disabled row doesn't.
    const longPress = useLongPress<DrivePath>((item, x, y) => controller.openContextMenuAt(item, x, y));

    // On touch nothing hovers and nothing right-clicks, so the 40px ⋮ column shows at every width.
    const coarse = useIsCoarsePointer();
    const colsKey = [!hideOwner && 'owner', !hideShared && 'shared', !hideModified && 'modified']
        .filter(Boolean)
        .join('-');
    const gridCols = hideActions
        ? cn(
              'grid-cols-[minmax(0,1fr)]',
              !hideModified && '@[600px]:grid-cols-[minmax(0,1fr)_15%]',
              GRID_COLS_800_NO_ACTIONS[colsKey],
          )
        : cn(
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
                <SortHeaderRow className={gridCols}>
                    <SortHeader
                        label="Name"
                        active={sortKey === 'name'}
                        dir={sortDir}
                        onClick={() => onSortHeader('name')}
                        className="flex pr-2"
                    />
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
                    <SortHeader
                        label="Size"
                        active={sortKey === 'size'}
                        dir={sortDir}
                        onClick={() => onSortHeader('size')}
                        align="right"
                        className="hidden @[800px]:flex pl-2 pr-4"
                    />
                    {!hideModified && (
                        <SortHeader
                            label={dateLabel}
                            active={sortKey === 'modified'}
                            dir={sortDir}
                            onClick={() => onSortHeader('modified')}
                            align="right"
                            className="hidden @[600px]:flex px-2"
                        />
                    )}
                    {!hideActions && <div className={coarse ? 'block' : 'hidden @[800px]:block'} />}
                </SortHeaderRow>
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
                                longPressBind={longPress.bind}
                                isActive={activeItemId === item.id || controller.selectedIndex === vi.index}
                                isSelected={
                                    controller.selection.isSelected(item.id) || !!externalSelectedIds?.has(item.id)
                                }
                                disabled={isItemDisabled?.(item) ?? false}
                                getItemHref={getItemHref}
                                onItemClick={onItemClick}
                                onShareClick={actions && ((path) => actions.run('share', [path]))}
                                hideOwner={hideOwner}
                                hideShared={hideShared}
                                hideModified={hideModified}
                                hideShareClick={hideShareClick}
                                hideActions={hideActions}
                                getItemDate={getItemDate}
                                ancestorBreadcrumb={ancestorBreadcrumb}
                                unreadPathIds={unreadPathIds}
                            />
                        </div>
                    );
                })}
            </div>

            {!hideActions && (
                <DriveItemContextMenu controller={controller} items={items} actions={actions} ownActions={ownActions} />
            )}
        </div>
    );
}
