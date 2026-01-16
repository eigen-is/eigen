import {KeyboardEvent, useCallback} from "react";
import {DrivePath} from "@apps/api-server/types/drive";

interface UseTableKeyboardProps {
    items: DrivePath[];
    selectedIndex: number;
    setSelectedIndex: (fn: (prev: number) => number) => void;
    hasParentItem: boolean;
    onItemClick?: (item: DrivePath) => void;
    onDelete?: (item: DrivePath) => void;
    scrollToRow: (index: number) => void;
    hasFocus: boolean;
}

export function useTableKeyboard({
    items,
    selectedIndex,
    setSelectedIndex,
    hasParentItem,
    onItemClick,
    onDelete,
    scrollToRow,
    hasFocus,
}: UseTableKeyboardProps) {
    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTableElement>) => {
        if (!hasFocus || items.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => {
                    const newIndex = Math.min(prev + 1, items.length - 1);
                    if (newIndex >= 0 && newIndex !== prev) {
                        if (!hasParentItem || newIndex > 0) {
                            onItemClick?.(items[newIndex]);
                        }
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
                        if (!hasParentItem || newIndex > 0) {
                            onItemClick?.(items[newIndex]);
                        }
                        scrollToRow(newIndex);
                    }
                    return newIndex;
                });
                break;

            case ' ':
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < items.length) {
                    onItemClick?.(items[selectedIndex]);
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
                    setSelectedIndex(() => 0);
                    scrollToRow(0);
                }
                break;

            case 'PageDown':
            case 'End':
                e.preventDefault();
                if (items.length > 0) {
                    const lastIndex = items.length - 1;
                    setSelectedIndex(() => lastIndex);
                    if (!hasParentItem || lastIndex > 0) {
                        onItemClick?.(items[lastIndex]);
                    }
                    scrollToRow(lastIndex);
                }
                break;
        }
    }, [hasFocus, items, selectedIndex, setSelectedIndex, hasParentItem, onItemClick, onDelete, scrollToRow]);

    return {handleKeyDown};
}
