import type React from 'react';
import { useContextMenu } from '../components/context-menu';
import type { UseListSelectionReturn } from './use-list-selection';

type UseSelectableContextMenuOptions<T> = {
    selection: UseListSelectionReturn<T>;
    getId: (item: T) => string;
};

// The select-then-open contract every list's context menu follows: right-click, touch
// long-press, and the ⋮ button all pull the pressed row into the selection before the menu
// opens — an unselected row becomes THE selection, an already-selected row keeps the
// multi-selection so the menu acts on the batch.
export function useSelectableContextMenu<T>({ selection, getId }: UseSelectableContextMenuOptions<T>) {
    const contextMenu = useContextMenu<T>();

    const ensureSelected = (item: T) => {
        if (!selection.isSelected(getId(item))) selection.select(getId(item));
    };

    const handleContextMenu = (e: React.MouseEvent, item: T) => {
        ensureSelected(item);
        contextMenu.handleContextMenu(e, item);
    };

    // For openers without a mouse position: touch long-press, keyboard-activated buttons.
    const openAt = (item: T, x: number, y: number) => {
        ensureSelected(item);
        contextMenu.openAt(item, x, y);
    };

    const openFromButton = (button: HTMLElement, item: T) => {
        const rect = button.getBoundingClientRect();
        openAt(item, rect.right, rect.bottom);
    };

    return { contextMenu, handleContextMenu, openAt, openFromButton };
}
