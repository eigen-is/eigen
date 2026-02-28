import {KeyboardEvent, RefObject, useEffect, useRef, useState} from 'react';
import type {UseListSelectionReturn} from './use-list-selection';

type UseKeyboardListNavigationOptions<T> = {
    items: T[];
    activeId?: string;
    getId: (item: T) => string;
    onSelect: (id: string) => void;
    containerRef: RefObject<HTMLElement | null>;
    itemSelector?: string;
    onDelete?: (item: T) => void;
    shouldNotify?: (item: T, index: number) => boolean;
    selection?: UseListSelectionReturn<T>;
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
                                                 selection,
                                             }: UseKeyboardListNavigationOptions<T>) {
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const getIdRef = useRef(getId);
    useEffect(() => {
        getIdRef.current = getId;
    });

    useEffect(() => {
        if (activeId && items.length > 0) {
            const index = items.findIndex(item => getIdRef.current(item) === activeId);
            if (index !== -1) {
                setSelectedIndex(index);
            }
        } else {
            setSelectedIndex(-1);
        }
    }, [activeId, items]);

    useEffect(() => {
        const timer = setTimeout(() => {
            if (containerRef.current && !containerRef.current.contains(document.activeElement)) {
                containerRef.current.focus({preventScroll: true});
            }
        }, 100);
        return () => clearTimeout(timer);
    }, [containerRef]);

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

    const updateSelection = (item: T, e: KeyboardEvent<HTMLElement>) => {
        if (!selection) return;
        const id = getId(item);
        if (e.shiftKey) selection.selectRange(id);
        else selection.select(id);
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
        if (items.length === 0) return;

        if (selection && (e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            selection.selectAll();
            return;
        }

        if (selection && e.key === 'Escape') {
            e.preventDefault();
            selection.clearSelection();
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.min(prev + 1, items.length - 1);
                    if (newIndex >= 0 && newIndex !== prev) {
                        updateSelection(items[newIndex], e);
                        if (!e.shiftKey) notify(items[newIndex], newIndex);
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
                        updateSelection(items[newIndex], e);
                        if (!e.shiftKey) notify(items[newIndex], newIndex);
                        scrollToRow(newIndex);
                    }
                    return newIndex;
                });
                break;

            case ' ':
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < items.length) {
                    onSelect(getId(items[selectedIndex]));
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
                    if (selection) selection.select(getId(items[0]));
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
                    if (selection) selection.select(getId(items[lastIndex]));
                    notify(items[lastIndex], lastIndex);
                    scrollToRow(lastIndex);
                }
                break;
        }
    };

    return {selectedIndex, setSelectedIndex, handleKeyDown};
}
