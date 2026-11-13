// The list view of a Drive listing: a virtualized table with sortable column headers, rows and their
// context menu. DriveList draws it in list mode, and the pickers draw it bare, without actions. It also
// holds the shared props of both listing views and useDriveSort, the sort a listing and its sort menu read.

import { useVirtualizer } from '@tanstack/react-virtual';
import { useDriveViewPreferences } from '@workspace/lib/drive';
import { useIsCoarsePointer } from '@workspace/lib/media';
import type { PaletteSelectionAction } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveSort, DriveSortDir, DriveSortKey } from '@workspace/lib/types/drive-view';
import { nextSortDir, SortHeader, SortHeaderRow } from '@workspace/ui/components/sort-header';
import { cn } from '@workspace/ui/lib/utils';
import { useRef } from 'react';
import type { UseListSelectionReturn } from '../../hooks/use-list-selection';
import { useLongPress } from '../../hooks/use-long-press';
import type { DriveActionRunner } from './drive-action-runner';
import { DriveItemContextMenu } from './drive-item-context-menu';
import { DriveRow } from './drive-row';
import { useDriveItemController } from './use-drive-item-controller';

// The direction a field starts in when a pick switches to it.
const DEFAULT_DIR: Record<DriveSortKey, DriveSortDir> = { name: 'asc', modified: 'desc', size: 'desc' };

const SORT_LABELS: Record<DriveSortKey, string> = { name: 'Name', modified: 'Modified', size: 'Size' };

// The label of a sort field in a column header or a sort menu. The date field takes the listing's own label.
export function driveSortLabel(key: DriveSortKey, dateLabel?: string): string {
    return key === 'modified' && dateLabel ? dateLabel : SORT_LABELS[key];
}

// The sort of a listing that keeps its own, such as a picker or the Recent page: a pick calls onChange and
// never writes the shared view preference.
export type DriveSortControl = { value: DriveSort; onChange: (sort: DriveSort) => void };

// The date a listing shows and sorts by under its own label, such as Trash's time trashed.
export type DriveListDate = { label: string; of: (item: DrivePath) => Date | null };

// The sort a listing draws: its own, else the shared view preference. choose is the pick of a column
// header or a sort menu, and it goes back to where the sort came from.
export function useDriveSort(sort?: DriveSortControl): DriveSort & { choose: (key: DriveSortKey) => void } {
    const prefs = useDriveViewPreferences();
    const { key, dir } = sort?.value ?? { key: prefs.sortKey, dir: prefs.sortDir };
    const choose = (picked: DriveSortKey) => {
        const next = nextSortDir(picked, key, dir, DEFAULT_DIR);
        if (sort) sort.onChange(next);
        else prefs.setSort(next.key, next.dir);
    };
    return { key, dir, choose };
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

export type DriveTableProps = DriveViewProps & {
    hideModified?: boolean;
    hideOwner?: boolean;
    hideShared?: boolean;
    hideShareClick?: boolean;
    hideHeader?: boolean;
    // Drops the ⋮ column and its grid track at every pointer type, for a picker such as DriveBrowser,
    // whose rows have no actions.
    hideActions?: boolean;
    date?: DriveListDate;
    ancestorBreadcrumb?: DrivePath[];
    sort?: DriveSortControl;
};

// Written out in full so Tailwind finds each class, keyed by the optional columns that show. Size shows
// from 800px on in every combination, so each carries its 10% track.
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
    items,
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
    date,
    selection,
    onSelectionChange,
    ownActions,
    sort,
}: DriveTableProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const { key: sortKey, dir: sortDir, choose: onSortHeader } = useDriveSort(sort);

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
                        label={driveSortLabel('name')}
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
                        label={driveSortLabel('size')}
                        active={sortKey === 'size'}
                        dir={sortDir}
                        onClick={() => onSortHeader('size')}
                        align="right"
                        className="hidden @[800px]:flex pl-2 pr-4"
                    />
                    {!hideModified && (
                        <SortHeader
                            label={driveSortLabel('modified', date?.label)}
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
                {virtualizer.getVirtualItems().map((virtualRow) => {
                    const item = items[virtualRow.index];
                    return (
                        <div
                            key={item.id}
                            data-index={virtualRow.index}
                            ref={virtualizer.measureElement}
                            className="absolute inset-x-0 top-0"
                            style={{
                                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                            }}
                        >
                            <DriveRow
                                item={item}
                                index={virtualRow.index}
                                gridCols={gridCols}
                                coarse={coarse}
                                controller={controller}
                                longPressBind={longPress.bind}
                                isActive={activeItemId === item.id}
                                isCursor={controller.selectedIndex === virtualRow.index}
                                isSelected={controller.selection.isSelected(item.id)}
                                disabled={isItemDisabled?.(item) ?? false}
                                getItemHref={getItemHref}
                                onItemClick={onItemClick}
                                onShareClick={actions && ((path) => actions.run('share', [path]))}
                                hideOwner={hideOwner}
                                hideShared={hideShared}
                                hideModified={hideModified}
                                hideShareClick={hideShareClick}
                                hideActions={hideActions}
                                getItemDate={date?.of}
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
