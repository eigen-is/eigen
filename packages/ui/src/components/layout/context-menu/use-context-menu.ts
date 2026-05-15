import { useCallback, useState } from 'react';

export function useContextMenu<T>() {
    const [item, setItem] = useState<T | null>(null);
    const [position, setPosition] = useState({ x: 0, y: 0 });

    const handleContextMenu = useCallback((e: React.MouseEvent, item: T) => {
        e.preventDefault();
        e.stopPropagation();
        setItem(item);
        setPosition({ x: e.clientX, y: e.clientY });
    }, []);

    // For triggers that don't have a mouse position (e.g. a ⋮ button activated
    // via keyboard Enter — clientX/Y would be 0). Pass the trigger's
    // getBoundingClientRect() so the menu lands next to the button.
    const openAt = useCallback((item: T, x: number, y: number) => {
        setItem(item);
        setPosition({ x, y });
    }, []);

    const close = useCallback(() => setItem(null), []);

    return { item, position, isOpen: !!item, handleContextMenu, openAt, close };
}
