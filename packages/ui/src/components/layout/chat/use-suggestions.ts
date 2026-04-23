import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

type UseSuggestionsOptions<T> = {
    visible: boolean;
    onSelect: (item: T) => void;
    onEscape: () => void;
    // Fires on commit (Enter/Tab) when the list is empty. Use when a "commit nothing" should
    // still dismiss the suggest — @-mention uses this to strip the trailing `@query` text.
    onCommitEmpty?: () => void;
    // Pass keys through to the caller when the list is empty. True for suggests that should
    // stay invisible to the send handler when they have nothing to offer; false for suggests
    // that want to consume keys even with an empty list (default).
    passthroughWhenEmpty?: boolean;
    // Accept Shift+Enter as commit too. Default false (shift+Enter inserts a newline). Set
    // true on the @-mention suggest to preserve its historic commit-on-any-Enter behaviour.
    acceptShiftEnter?: boolean;
};

type UseSuggestionsResult<T> = {
    selectedIndex: number;
    onItemsChange: (count: number, items: T[]) => void;
    // Returns true when the key was consumed; callers should early-return in that case.
    handleKeyDown: (e: React.KeyboardEvent) => boolean;
};

export function useSuggestions<T>({
    visible,
    onSelect,
    onEscape,
    onCommitEmpty,
    passthroughWhenEmpty = false,
    acceptShiftEnter = false,
}: UseSuggestionsOptions<T>): UseSuggestionsResult<T> {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const countRef = useRef(0);
    const itemsRef = useRef<T[]>([]);

    const onItemsChange = useCallback((count: number, items: T[]) => {
        countRef.current = count;
        itemsRef.current = items;
        if (count > 0) setSelectedIndex((prev) => Math.min(prev, count - 1));
    }, []);

    useEffect(() => {
        if (!visible) setSelectedIndex(0);
    }, [visible]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent): boolean => {
            if (!visible) return false;
            const count = countRef.current;
            if (passthroughWhenEmpty && count === 0) return false;

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
                const item = itemsRef.current[selectedIndex];
                if (item !== undefined) {
                    onSelect(item);
                    setSelectedIndex(0);
                } else {
                    onCommitEmpty?.();
                }
                return true;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                onEscape();
                setSelectedIndex(0);
                return true;
            }
            return false;
        },
        [visible, passthroughWhenEmpty, acceptShiftEnter, selectedIndex, onSelect, onEscape, onCommitEmpty],
    );

    return { selectedIndex, onItemsChange, handleKeyDown };
}
