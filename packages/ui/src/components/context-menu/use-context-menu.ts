import { useCallback, useRef, useState } from 'react';

export function useContextMenu<T>() {
    const [item, setItem] = useState<T | null>(null);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    // The anchor's trigger is a zero-size pointer-events:none div that Radix
    // can't return focus to on close, so remember who had focus when the menu
    // opened and let the anchor restore it — otherwise focus drops to <body>
    // and the host's keyboard handling goes dead until the next click.
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

    // For triggers that don't have a mouse position (e.g. a ⋮ button activated
    // via keyboard Enter — clientX/Y would be 0). Pass the trigger's
    // getBoundingClientRect() so the menu lands next to the button.
    const openAt = useCallback((item: T, x: number, y: number) => {
        captureFocus();
        setItem(item);
        setPosition({ x, y });
    }, []);

    const restoreFocus = useCallback(() => {
        if (openedFrom.current?.isConnected) openedFrom.current.focus();
        openedFrom.current = null;
    }, []);

    const close = useCallback(() => setItem(null), []);

    return { item, position, isOpen: !!item, handleContextMenu, openAt, close, restoreFocus };
}
