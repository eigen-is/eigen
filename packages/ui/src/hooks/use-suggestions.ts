// The keys of a suggestion list under a text box, such as the chat composer's @-mention and slash command lists or
// the sheet's formula names: the arrows move the pick, Enter or Tab commits it, and Escape closes the list. The box
// decides when its list is visible from what it holds; a list closed with Escape keeps the text and stays closed
// until the box stops asking for it.

import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

type UseSuggestionsOptions = {
    visible: boolean;
    onSelect: (item: string) => void;
    onEscape?: () => void;
    // An empty list leaves every key to the box, so Enter sends what is typed.
    passthroughWhenEmpty?: boolean;
    // Shift+Enter commits too, where it would otherwise be a newline.
    acceptShiftEnter?: boolean;
};

type UseSuggestionsResult = {
    // Whether the list shows: visible, and not closed with Escape since it last opened.
    open: boolean;
    selectedIndex: number;
    onItemsChange: (count: number, items: string[]) => void;
    // True when the list took the key, so the box ignores it.
    handleKeyDown: (e: React.KeyboardEvent) => boolean;
    // Whether handleKeyDown takes keys right now: the input's aria-expanded.
    isActive: boolean;
};

export function useSuggestions({
    visible,
    onSelect,
    onEscape,
    passthroughWhenEmpty = false,
    acceptShiftEnter = false,
}: UseSuggestionsOptions): UseSuggestionsResult {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const selectedIndexRef = useRef(0);
    const [count, setCount] = useState(0);
    const [dismissed, setDismissed] = useState(false);
    const itemsRef = useRef<string[]>([]);

    selectedIndexRef.current = selectedIndex;

    const onItemsChange = useCallback((count: number, items: string[]) => {
        setCount(count);
        itemsRef.current = items;
        if (count > 0) setSelectedIndex((prev) => Math.min(prev, count - 1));
    }, []);

    useEffect(() => {
        if (visible) return;
        setSelectedIndex(0);
        setDismissed(false);
    }, [visible]);

    const open = visible && !dismissed;
    const isActive = open && !(passthroughWhenEmpty && count === 0);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent): boolean => {
            if (!isActive) return false;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (count > 0) setSelectedIndex((i) => Math.min(i + 1, count - 1));
                return true;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (count > 0) setSelectedIndex((i) => Math.max(i - 1, 0));
                return true;
            }
            const isCommit = e.key === 'Tab' || (e.key === 'Enter' && (acceptShiftEnter || !e.shiftKey));
            if (isCommit) {
                e.preventDefault();
                const item = itemsRef.current[selectedIndexRef.current];
                if (item !== undefined) {
                    onSelect(item);
                    setSelectedIndex(0);
                }
                return true;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(true);
                onEscape?.();
                setSelectedIndex(0);
                return true;
            }
            return false;
        },
        [isActive, count, acceptShiftEnter, onSelect, onEscape],
    );

    return { open, selectedIndex, onItemsChange, handleKeyDown, isActive };
}
