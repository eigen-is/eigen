// One person list for contacts and admin: alphabetically grouped rows with shared keyboard navigation,
// plus opt-in selection, drag and a context menu. The page renders each row's content and owns the
// chrome around it, such as toolbars, loading states and the detail beside the list.

import { useKeyboardListNavigation } from '@workspace/ui/hooks/use-keyboard-list-navigation';
import { useListDrag } from '@workspace/ui/hooks/use-list-drag';
import { useListSelection } from '@workspace/ui/hooks/use-list-selection';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { useSelectableContextMenu } from '@workspace/ui/hooks/use-selectable-context-menu';
import { cn, HOVER_REVEAL_CLASS } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { useMemo, useRef } from 'react';
import { ContextMenuAnchor, ContextMenuButton } from '../context-menu';
import { AlphabeticalList, alphaGroupKey } from './alphabetical-list';

type PersonListProps<T> = {
    items: readonly T[];
    searchQuery: string;
    activeId?: string;
    getId: (item: T) => string;
    // The key that selection and drag use, when it differs from the one a row routes by. Admin's member list, for
    // example, routes by membership id but selects by user id.
    getSelectionId?: (item: T) => string;
    // The list sorts by this name, and its letter headers come from it too.
    getName: (item: T) => string;
    getSearchFields: (item: T) => string[];
    onRowClick: (id: string) => void;
    renderPerson: (item: T) => ReactNode;
    emptyState: ReactNode;
    selectable?: boolean;
    dragType?: string;
    // With menu items, a right-click, a long press, a row's ⋮ button or the menu key opens one shared menu. The pressed
    // row joins the selection first, and the menu acts on the whole selection.
    renderMenuItems?: (items: T[], close: () => void) => ReactNode;
    // The Delete and Backspace keys call this, as the menu's delete entry does.
    onDelete?: (items: T[]) => void;
};

export function PersonList<T>({
    items,
    searchQuery,
    activeId,
    getId,
    getSelectionId = getId,
    getName,
    getSearchFields,
    onRowClick,
    renderPerson,
    emptyState,
    selectable,
    dragType,
    renderMenuItems,
    onDelete,
}: PersonListProps<T>) {
    const listRef = useRef<HTMLDivElement>(null);

    const visible = useMemo(() => {
        // Letter by letter, as AlphabeticalList draws them, so the keyboard cursor's index is the drawn row's.
        const sorted = [...items].sort(
            (a, b) =>
                alphaGroupKey(getName(a)).localeCompare(alphaGroupKey(getName(b))) ||
                getName(a).localeCompare(getName(b)),
        );
        if (!searchQuery) return sorted;
        const query = searchQuery.toLowerCase();
        return sorted.filter((item) => getSearchFields(item).some((field) => field.toLowerCase().includes(query)));
    }, [items, searchQuery, getName, getSearchFields]);

    // The open row is looked up in all items, so a search that hides it doesn't count as closing it.
    const openItem = activeId === undefined ? undefined : items.find((item) => getId(item) === activeId);
    const selection = useListSelection({
        items: visible,
        getId: getSelectionId,
        openId: openItem && getSelectionId(openItem),
    });
    const drag = useListDrag({ selection, getId: getSelectionId, dragType: dragType ?? 'person' });

    const { contextMenu, handleContextMenu, openAt, openBelow } = useSelectableContextMenu({
        selection,
        getId: getSelectionId,
    });
    const longPress = useLongPress(openAt);

    const { selectedIndex, handleKeyDown } = useKeyboardListNavigation({
        items: visible,
        activeId,
        getId,
        getSelectionId,
        onSelect: onRowClick,
        containerRef: listRef,
        selection: selectable ? selection : undefined,
        // With several rows selected, the keys delete them all and not just the cursor's row, as the menu does.
        onDelete: onDelete
            ? (item) => onDelete(selection.selectedCount > 1 ? selection.selectedItems : [item])
            : undefined,
        // The menu key opens the menu at the row, as its ⋮ does. The list draws every row, so the hook hands it over.
        onMenu: renderMenuItems
            ? (item, _index, row) => {
                  if (row) openBelow(row, item);
              }
            : undefined,
    });

    const menuItems = contextMenu.item
        ? selection.selectedCount > 1
            ? selection.selectedItems
            : [contextMenu.item]
        : [];

    return (
        <div className="flex-1 overflow-y-auto outline-none" tabIndex={0} ref={listRef} onKeyDown={handleKeyDown}>
            {visible.length === 0 ? (
                emptyState
            ) : (
                <AlphabeticalList
                    items={visible}
                    getKey={getId}
                    getGroupKey={(item) => alphaGroupKey(getName(item))}
                    renderItem={(item, flatIndex) => (
                        <div
                            className={cn(
                                'flex items-center gap-3 app-gutter-x py-3 eigen-list-item',
                                renderMenuItems && 'group',
                                // As in Mail: the open row gets the stripe and the wash, the cursor on another row the
                                // stripe only.
                                activeId === getId(item) && 'eigen-list-item-active',
                                activeId !== getId(item) && selectedIndex === flatIndex && 'eigen-list-item-cursor',
                                selectable && selection.isSelected(getSelectionId(item)) && 'eigen-list-item-selected',
                            )}
                            onClick={(e) => {
                                if (selectable) {
                                    selection.handleItemClick(getSelectionId(item), e);
                                    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
                                }
                                onRowClick(getId(item));
                            }}
                            onContextMenu={renderMenuItems ? (e) => handleContextMenu(e, item) : undefined}
                            {...(dragType ? drag.getDragProps(item) : undefined)}
                            {...(renderMenuItems ? longPress.bind(item) : undefined)}
                        >
                            {renderPerson(item)}
                            {renderMenuItems && (
                                <ContextMenuButton
                                    onOpen={(button) => openBelow(button, item)}
                                    className={cn(HOVER_REVEAL_CLASS, 'h-7 w-7 shrink-0')}
                                />
                            )}
                        </div>
                    )}
                />
            )}

            {renderMenuItems && (
                <ContextMenuAnchor contextMenu={contextMenu} className="min-w-[200px]">
                    {renderMenuItems(menuItems, contextMenu.close)}
                </ContextMenuAnchor>
            )}
        </div>
    );
}
