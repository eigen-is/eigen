import { cn } from '@workspace/ui/lib/utils';
import { MoreVertical } from 'lucide-react';
import { type ReactNode, useMemo, useRef } from 'react';
import { useKeyboardListNavigation } from '../../hooks/use-keyboard-list-navigation';
import { useListDrag } from '../../hooks/use-list-drag';
import { useListSelection } from '../../hooks/use-list-selection';
import { useLongPress } from '../../hooks/use-long-press';
import { useSelectableContextMenu } from '../../hooks/use-selectable-context-menu';
import { AlphabeticalList, alphaGroupKey } from './alphabetical-list';
import { ContextMenuAnchor } from './context-menu';

type PersonListProps<T> = {
    items: T[];
    searchQuery: string;
    activeId?: string;
    getId: (item: T) => string;
    // For lists where the selection/drag key differs from the routing key (admin members
    // route by membership id but select/drag by userId). Defaults to getId.
    getSelectionId?: (item: T) => string;
    // Sorting and the alphabetical group headers both key off this name.
    getName: (item: T) => string;
    getSearchFields: (item: T) => string[];
    onRowClick: (id: string) => void;
    renderPerson: (item: T) => ReactNode;
    emptyState: ReactNode;
    selectable?: boolean;
    dragType?: string;
    // Present → rows get right-click, touch long-press, and a hover ⋮ button, all opening the
    // singleton menu on the selected batch (the pressed row is pulled into the selection first).
    renderMenuItems?: (items: T[], close: () => void) => ReactNode;
};

// One person list for contacts and admin: alphabetically grouped rows (diacritics folded via
// alphaGroupKey) with shared keyboard navigation, plus opt-in selection, drag, and context menu.
// The adopter renders the row content (UserItem) and owns the surrounding chrome — toolbars,
// error/loading states, detail panes.
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
}: PersonListProps<T>) {
    const listRef = useRef<HTMLDivElement>(null);

    const visible = useMemo(() => {
        const sorted = [...items].sort((a, b) => getName(a).localeCompare(getName(b)));
        if (!searchQuery) return sorted;
        const q = searchQuery.toLowerCase();
        return sorted.filter((item) => getSearchFields(item).some((field) => field.toLowerCase().includes(q)));
    }, [items, searchQuery, getName, getSearchFields]);

    const selection = useListSelection({ items: visible, getId: getSelectionId });
    const drag = useListDrag({ selection, getId: getSelectionId, dragType: dragType ?? 'person' });

    // Right-click, touch long-press, and the ⋮ button all select-then-open the same menu.
    const { contextMenu, handleContextMenu, openAt, openFromButton } = useSelectableContextMenu({
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
                                'flex items-center gap-3 px-6 py-3 eigen-list-item',
                                renderMenuItems && 'group',
                                (activeId === getId(item) || selectedIndex === flatIndex) && 'eigen-list-item-active',
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
                                <button
                                    type="button"
                                    aria-label="More actions"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        openFromButton(e.currentTarget, item);
                                    }}
                                    className="invisible flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground group-hover:visible pointer-coarse:visible hover:bg-accent"
                                >
                                    <MoreVertical className="h-4 w-4" />
                                </button>
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
