import {useEffect, useState, RefObject, KeyboardEvent} from 'react';

type UseKeyboardListNavigationOptions<T> = {
    items: T[];
    activeId?: string;
    getId: (item: T) => string;
    onSelect: (id: string) => void;
    containerRef: RefObject<HTMLElement | null>;
    itemSelector?: string;
    onDelete?: (item: T) => void;
    shouldNotify?: (item: T, index: number) => boolean;
}

export function useKeyboardListNavigation<T>({
    items,
    activeId,
    getId,
    onSelect,
    containerRef,
    itemSelector = '.eigen-list-item',
    onDelete,
    shouldNotify,
}: UseKeyboardListNavigationOptions<T>) {
    const [selectedIndex, setSelectedIndex] = useState(-1);

    useEffect(() => {
        if (activeId && items.length > 0) {
            const index = items.findIndex(item => getId(item) === activeId);
            if (index !== -1) {
                setSelectedIndex(index);
            }
        } else {
            setSelectedIndex(-1);
        }
    }, [activeId, items, getId]);

    const scrollToRow = (index: number) => {
        if (containerRef.current) {
            const listItems = containerRef.current.querySelectorAll(itemSelector);
            if (listItems[index]) {
                listItems[index].scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest'
                });
            }
        }
    };

    const notify = (item: T, index: number) => {
        if (!shouldNotify || shouldNotify(item, index)) {
            onSelect(getId(item));
        }
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
        if (items.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.min(prev + 1, items.length - 1);
                    if (newIndex >= 0 && newIndex !== prev) {
                        notify(items[newIndex], newIndex);
                        scrollToRow(newIndex);
                    }
                    return newIndex;
                });
                break;

            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.max(prev - 1, 0);
                    if (newIndex >= 0 && newIndex !== prev) {
                        notify(items[newIndex], newIndex);
                        scrollToRow(newIndex);
                    }
                    return newIndex;
                });
                break;

            case ' ':
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < items.length) {
                    notify(items[selectedIndex], selectedIndex);
                    scrollToRow(selectedIndex);
                }
                break;

            case 'Delete':
                e.preventDefault();
                if (onDelete && selectedIndex >= 0 && selectedIndex < items.length) {
                    onDelete(items[selectedIndex]);
                }
                break;

            case 'PageUp':
            case 'Home':
                e.preventDefault();
                if (items.length > 0) {
                    setSelectedIndex(0);
                    notify(items[0], 0);
                    scrollToRow(0);
                }
                break;

            case 'PageDown':
            case 'End':
                e.preventDefault();
                if (items.length > 0) {
                    const lastIndex = items.length - 1;
                    setSelectedIndex(lastIndex);
                    notify(items[lastIndex], lastIndex);
                    scrollToRow(lastIndex);
                }
                break;
        }
    };

    return {selectedIndex, setSelectedIndex, handleKeyDown};
}
