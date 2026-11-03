// The state of one context menu: the item it acts on, where it opens, and the element that had the focus when it
// opened. A host such as a Drive list, a chat message list or a canvas calls this hook, opens the menu from a
// right-click, a long press or a ⋮ button, and passes the result to ContextMenuAnchor, which draws the menu and calls
// restoreFocus as the menu closes.

import { useCallback, useRef, useState } from 'react';
import { returnFocusTo } from '../../hooks/use-focus-return';

export function useContextMenu<T>() {
    const [item, setItem] = useState<T | null>(null);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    // Radix gives the focus back to the menu's trigger as it closes, but the anchor's trigger is an empty div that
    // can't take it. The focus would fall to the page body, and the host's keys would do nothing until a click.
    const openedFrom = useRef<HTMLElement | null>(null);

    const captureFocus = () => {
        openedFrom.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    };

    const handleContextMenu = useCallback((e: React.MouseEvent, item: T) => {
        e.preventDefault();
        e.stopPropagation();
        captureFocus();
        setItem(item);
        setPosition({ x: e.clientX, y: e.clientY });
    }, []);

    // For an opener without a mouse position, such as a ⋮ button pressed with Enter. The caller passes a point next to
    // the button, from its getBoundingClientRect().
    const openAt = useCallback((item: T, x: number, y: number) => {
        captureFocus();
        setItem(item);
        setPosition({ x, y });
    }, []);

    // A row that focused something, such as a chat message's edit box or the field of the dialog it opened, keeps
    // the focus. That dialog gives the focus back to openedFrom when it closes.
    const restoreFocus = useCallback(() => {
        if (openedFrom.current?.isConnected) returnFocusTo(openedFrom.current);
        openedFrom.current = null;
    }, []);

    const close = useCallback(() => setItem(null), []);

    return { item, position, isOpen: !!item, handleContextMenu, openAt, close, restoreFocus };
}
