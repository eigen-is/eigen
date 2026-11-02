// The keyboard model of a list or grid of rows, such as Drive's listing, mail's message list or a contact list: the
// arrows move a cursor, Enter opens the row, Space quick-looks it, Delete removes it and ⌘A selects every row. The
// list spreads the returned handleKeyDown on its focusable container, and the hook keeps the focus on that container
// while nothing else holds it.

import type { KeyboardEvent, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { UseListSelectionReturn } from './use-list-selection';

// Both props or neither. With both, the parent owns the cursor. Mail does this: it tracks the cursor by email id, so
// the cursor survives a new sort or new mail, and its shortcuts read the same cursor. The hook then moves from
// cursorIndex, reports each move to onCursorChange, and leaves activeId alone, since the parent decides where the
// cursor goes when a row opens.
type LiftedCursorOptions =
    | { cursorIndex: number; onCursorChange: (index: number) => void }
    | { cursorIndex?: undefined; onCursorChange?: undefined };

type UseKeyboardListNavigationOptions<T> = {
    items: T[];
    activeId?: string;
    getId: (item: T) => string;
    // For a list whose selection key is not its routing key, such as admin members, which route by membership id but
    // select and drag by user id. Defaults to getId.
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
    // Off while another part of the page owns typing, such as mail's inline composer. The list then neither takes the
    // focus on mount nor takes it back from <body>, so the arrows can't switch conversations under a half-written
    // reply. On by default.
    reclaimFocus?: boolean;
} & LiftedCursorOptions;

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
    reclaimFocus = true,
    cursorIndex,
    onCursorChange,
}: UseKeyboardListNavigationOptions<T>) {
    const lifted = cursorIndex !== undefined;
    const [internalIndex, setInternalIndex] = useState(-1);
    const selectedIndex = cursorIndex ?? internalIndex;
    const setSelectedIndex: (index: number) => void = onCursorChange ?? setInternalIndex;

    const getIdRef = useRef(getId);
    useEffect(() => {
        getIdRef.current = getId;
    });

    useEffect(() => {
        if (lifted) return;
        if (activeId && items.length > 0) {
            const index = items.findIndex((item) => getIdRef.current(item) === activeId);
            if (index !== -1) {
                setInternalIndex(index);
            }
        } else {
            setInternalIndex(-1);
        }
    }, [lifted, activeId, items]);

    // The list owns the keyboard, so it takes the focus on mount, and takes it back whenever the focus falls to <body>.
    // A click on something that can't take focus, such as the detail panel or a toolbar, leaves nothing focused, and
    // so does a page restored from the back/forward cache. Every key here would then do nothing until the user
    // clicked a row again. Turning reclaimFocus back on starts the timer again. That also covers a closed composer
    // that held the focus, because a focused element that unmounts fires no focusout.
    useEffect(() => {
        if (!reclaimFocus) return;
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
    }, [containerRef, reclaimFocus]);

    const scrollToRow = (index: number) => {
        if (scrollToIndex) {
            scrollToIndex(index);
            return;
        }
        const container = containerRef.current;
        if (!container) return;
        const item = container.querySelectorAll(itemSelector)[index];
        if (!(item instanceof HTMLElement)) return;
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
        // React bubbles a key through its own tree, so a dialog that a row's menu portals to the body would reach the
        // list too: Enter in its field would open the row. Only a key pressed inside the list's own DOM is the list's.
        if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
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
            const next = computeNext(selectedIndex);
            if (next >= 0 && next !== selectedIndex) {
                updateSelection(items[next], e);
                if (!e.shiftKey) notify(items[next], next);
                scrollToRow(next);
            }
            setSelectedIndex(next);
        };

        // ⌘A on a list nobody clicked yet selects every row while the cursor is still at -1. Space, Enter and Delete
        // then act on the topmost selected row, and a list's onDelete may widen that to the whole selection.
        const targetIndex = () =>
            selectedIndex >= 0 && selectedIndex < items.length
                ? selectedIndex
                : items.findIndex((item) => selection?.isSelected(getSelectionId(item)));

        switch (e.key) {
            case 'ArrowDown':
                // With no row under the cursor, Down starts at the first row, also in a grid.
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

            case ' ': {
                e.preventDefault();
                // React renders the quick-look overlay before this native event finishes bubbling,
                // so without this the overlay's own Space-to-close hotkey (on document) would shut
                // it again on the very press that opened it.
                e.stopPropagation();
                const index = targetIndex();
                if (index >= 0) {
                    const id = getId(items[index]);
                    if (onQuickLook) onQuickLook(id);
                    else onSelect(id);
                    scrollToRow(index);
                }
                break;
            }

            case 'Enter': {
                e.preventDefault();
                const index = targetIndex();
                if (index >= 0) {
                    onSelect(getId(items[index]));
                    scrollToRow(index);
                }
                break;
            }

            // Backspace deletes too, the way Finder, Apple Mail and Contacts do on macOS.
            case 'Delete':
            case 'Backspace': {
                e.preventDefault();
                const index = targetIndex();
                if (onDelete && index >= 0) onDelete(items[index]);
                break;
            }

            case 'PageUp':
            case 'Home':
                e.preventDefault();
                jumpTo(0);
                break;

            case 'PageDown':
            case 'End':
                e.preventDefault();
                jumpTo(items.length - 1);
                break;
        }
    };

    const jumpTo = (index: number) => {
        setSelectedIndex(index);
        selection?.select(getSelectionId(items[index]));
        notify(items[index], index);
        scrollToRow(index);
    };

    return { selectedIndex, handleKeyDown };
}
