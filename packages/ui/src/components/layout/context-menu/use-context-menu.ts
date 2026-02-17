import {useCallback, useState} from 'react';

export function useContextMenu<T>() {
    const [item, setItem] = useState<T | null>(null);
    const [position, setPosition] = useState({x: 0, y: 0});

    const handleContextMenu = useCallback((e: React.MouseEvent, item: T) => {
        e.preventDefault();
        setItem(item);
        setPosition({x: e.clientX, y: e.clientY});
    }, []);

    const close = useCallback(() => setItem(null), []);

    return {item, position, isOpen: !!item, handleContextMenu, close};
}
