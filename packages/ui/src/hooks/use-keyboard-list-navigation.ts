import {useEffect, useState, RefObject, KeyboardEvent} from 'react';

type UseKeyboardListNavigationOptions<T> = {
    items: T[];
    activeId?: string;
    getId: (item: T) => string;
    onSelect: (id: string) => void;
    containerRef: RefObject<HTMLElement | null>;
    itemSelector?: string; // default: '.eigen-list-item'
}

export function useKeyboardListNavigation<T>({
    items,
    activeId,
    getId,
    onSelect,
    containerRef,
    itemSelector = '.eigen-list-item'
}: UseKeyboardListNavigationOptions<T>) {
    const [selectedIndex, setSelectedIndex] = useState(-1);

    // Sync selectedIndex with activeId
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

    // Helper function to scroll to a specific row
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

    // Handle keyboard navigation
    const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
        if (items.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.min(prev + 1, items.length - 1);
                    if (newIndex >= 0) {
                        // Select item
                        onSelect(getId(items[newIndex]));
                        // Scroll to selected row
                        scrollToRow(newIndex);
                    }
                    return newIndex;
                });
                break;

            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.max(prev - 1, 0);
                    if (newIndex >= 0) {
                        // Select item
                        onSelect(getId(items[newIndex]));
                        // Scroll to selected row
                        scrollToRow(newIndex);
                    }
                    return newIndex;
                });
                break;

            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < items.length) {
                    onSelect(getId(items[selectedIndex]));
                    // Scroll to selected row
                    scrollToRow(selectedIndex);
                }
                break;

            case 'Home':
                e.preventDefault();
                if (items.length > 0) {
                    setSelectedIndex(0);
                    onSelect(getId(items[0]));
                    // Scroll to first row
                    scrollToRow(0);
                }
                break;

            case 'End':
                e.preventDefault();
                if (items.length > 0) {
                    const lastIndex = items.length - 1;
                    setSelectedIndex(lastIndex);
                    onSelect(getId(items[lastIndex]));
                    // Scroll to last row
                    scrollToRow(lastIndex);
                }
                break;
        }
    };

    return {selectedIndex, handleKeyDown};
}
