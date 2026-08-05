import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react';
import type { UseListSelectionReturn } from './use-list-selection';

type UseKeyboardListNavigationOptions<T> = {
    items: T[];
    activeId?: string;
    getId: (item: T) => string;
    // For lists where the selection key differs from the routing key (admin members
    // route by membership id but select/drag by userId). Defaults to getId.
    getSelectionId?: (item: T) => string;
    onSelect: (id: string) => void;
    onQuickLook?: (id: string) => void;
    containerRef: RefObject<HTMLElement | null>;
    itemSelector?: string;
    onDelete?: (item: T) => void;
    shouldNotify?: (item: T, index: number) => boolean;
    selection?: UseListSelectionReturn<T>;
    columns?: number;
    scrollToIndex?: (index: number) => void;
};

export function useKeyboardListNavigation<T>({
    items,
    activeId,
    getId,
    getSelectionId = getId,
    onSelect,
    containerRef,
    itemSelector = '.eigen-list-item',
    onDelete,
    shouldNotify,
    selection,
    onQuickLook,
    columns = 1,
    scrollToIndex,
}: UseKeyboardListNavigationOptions<T>) {
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const getIdRef = useRef(getId);
    useEffect(() => {
        getIdRef.current = getId;
    });

    useEffect(() => {
        if (activeId && items.length > 0) {
            const index = items.findIndex((item) => getIdRef.current(item) === activeId);
            if (index !== -1) {
                setSelectedIndex(index);
            }
        } else {
            setSelectedIndex(-1);
        }
    }, [activeId, items]);

    // The list owns the keyboard model, so it takes focus on mount — and takes it back whenever
    // focus falls to <body>. Clicking non-focusable chrome (the detail panel, a toolbar) or
    // restoring the page from the back/forward cache leaves nothing focused, and every shortcut
    // here would stay dead until the user clicked a row again.
    useEffect(() => {
        const focusList = () => containerRef.current?.focus({ preventScroll: true });

        const timer = setTimeout(() => {
            if (!containerRef.current?.contains(document.activeElement)) focusList();
        }, 100);

        const reclaim = () => {
            if (document.activeElement === document.body) focusList();
        };
        // focusout fires before the next element takes focus, so re-check on the next tick.
        const onFocusOut = () => setTimeout(reclaim, 0);
        document.addEventListener('focusout', onFocusOut);
        window.addEventListener('pageshow', reclaim);

        return () => {
            clearTimeout(timer);
            document.removeEventListener('focusout', onFocusOut);
            window.removeEventListener('pageshow', reclaim);
        };
    }, [containerRef]);

    const scrollToRow = (index: number) => {
        if (scrollToIndex) {
            scrollToIndex(index);
            return;
        }
        const container = containerRef.current;
        if (!container) return;
        const item = container.querySelectorAll(itemSelector)[index] as HTMLElement | undefined;
        if (!item) return;
        const itemTop = item.offsetTop;
        const itemBottom = itemTop + item.offsetHeight;
        if (itemTop < container.scrollTop) {
            container.scrollTop = itemTop;
        } else if (itemBottom > container.scrollTop + container.clientHeight) {
            container.scrollTop = itemBottom - container.clientHeight;
        }
    };

    const notify = (item: T, index: number) => {
        if (!shouldNotify || shouldNotify(item, index)) {
            onSelect(getId(item));
        }
    };

    const updateSelection = (item: T, e: KeyboardEvent<HTMLElement>) => {
        if (!selection) return;
        const id = getSelectionId(item);
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

        const moveTo = (computeNext: (prev: number) => number) => {
            e.preventDefault();
            setSelectedIndex((prev) => {
                const next = computeNext(prev);
                if (next >= 0 && next !== prev) {
                    updateSelection(items[next], e);
                    if (!e.shiftKey) notify(items[next], next);
                    scrollToRow(next);
                }
                return next;
            });
        };

        switch (e.key) {
            case 'ArrowDown':
                // From no selection, Down enters at the first item — not columns-1 in a grid.
                moveTo((prev) => (prev < 0 ? 0 : Math.min(prev + columns, items.length - 1)));
                break;

            case 'ArrowUp':
                moveTo((prev) => Math.max(prev - columns, 0));
                break;

            case 'ArrowRight':
                if (columns > 1) moveTo((prev) => Math.min(prev + 1, items.length - 1));
                break;

            case 'ArrowLeft':
                if (columns > 1) moveTo((prev) => Math.max(prev - 1, 0));
                break;

            case ' ':
                e.preventDefault();
                // React renders the quick-look overlay before this native event finishes bubbling,
                // so without this the overlay's own Space-to-close hotkey (on document) would shut
                // it again on the very press that opened it.
                e.stopPropagation();
                if (selectedIndex >= 0 && selectedIndex < items.length) {
                    const id = getId(items[selectedIndex]);
                    if (onQuickLook) onQuickLook(id);
                    else onSelect(id);
                    scrollToRow(selectedIndex);
                }
                break;

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
                    if (selection) selection.select(getSelectionId(items[0]));
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
                    if (selection) selection.select(getSelectionId(items[lastIndex]));
                    notify(items[lastIndex], lastIndex);
                    scrollToRow(lastIndex);
                }
                break;
        }
    };

    return { selectedIndex, setSelectedIndex, handleKeyDown };
}
