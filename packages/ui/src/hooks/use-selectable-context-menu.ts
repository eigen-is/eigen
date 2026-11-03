// The context menu of a list whose rows can be selected, such as a Drive listing, the mail list or a person list. A
// right-click, a long press, a row's ⋮ button or the menu key first pulls the row into the selection, then opens the
// one menu. An unselected row becomes the selection. A row already selected keeps the selection it is part of, so the
// menu acts on all of it.

import type React from 'react';
import { useContextMenu } from '../components/context-menu';
import type { UseListSelectionReturn } from './use-list-selection';

type UseSelectableContextMenuOptions<T> = {
    selection: UseListSelectionReturn<T>;
    getId: (item: T) => string;
};

export function useSelectableContextMenu<T>({ selection, getId }: UseSelectableContextMenuOptions<T>) {
    const contextMenu = useContextMenu<T>();

    const ensureSelected = (item: T) => {
        if (!selection.isSelected(getId(item))) selection.select(getId(item));
    };

    const handleContextMenu = (e: React.MouseEvent, item: T) => {
        ensureSelected(item);
        contextMenu.handleContextMenu(e, item);
    };

    // For an opener without a pointer position of its own, such as a long press.
    const openAt = (item: T, x: number, y: number) => {
        ensureSelected(item);
        contextMenu.openAt(item, x, y);
    };

    // Opens the menu below an element's right edge, such as a row's ⋮ button or the row the menu key acts on.
    const openBelow = (element: HTMLElement, item: T) => {
        const rect = element.getBoundingClientRect();
        openAt(item, rect.right, rect.bottom);
    };

    return { contextMenu, handleContextMenu, openAt, openBelow };
}
