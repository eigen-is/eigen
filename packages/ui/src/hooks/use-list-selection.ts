// The selection of a list of rows, such as files, emails or people: a click selects one row, a
// Shift-click a range from the anchor and a Cmd- or Ctrl-click toggles one. The list draws the
// selected rows and its context menu, drag and keyboard act on them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type UseListSelectionOptions<T> = {
    items: T[];
    getId: (item: T) => string;
    // The row whose detail the page has open, for a list where a click opens a row. The click also
    // selected that row. So when the detail closes and that row is the whole selection, the selection
    // is dropped, and the closed row no longer looks selected.
    openId?: string;
};

export type UseListSelectionReturn<T> = {
    selectedIds: ReadonlySet<string>;
    isSelected: (id: string) => boolean;
    selectedItems: T[];
    selectedCount: number;
    hasSelection: boolean;
    select: (id: string) => void;
    toggle: (id: string) => void;
    selectRange: (toId: string) => void;
    selectAll: () => void;
    setSelection: (ids: string[]) => void;
    clearSelection: () => void;
    handleItemClick: (id: string, e: React.MouseEvent) => void;
};

export function useListSelection<T>({ items, getId, openId }: UseListSelectionOptions<T>): UseListSelectionReturn<T> {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    // The row a Shift-click range starts from. Only selectRange reads it and no render shows it, so a ref.
    const anchorRef = useRef<string | null>(null);

    // A selection the user built with Shift or Cmd stays when the detail closes.
    const lastOpenId = useRef(openId);
    useEffect(() => {
        const closedId = lastOpenId.current;
        lastOpenId.current = openId;
        if (!closedId || openId) return;
        setSelectedIds((prev) => (prev.size === 1 && prev.has(closedId) ? new Set() : prev));
    }, [openId]);

    const select = useCallback((id: string) => {
        setSelectedIds(new Set([id]));
        anchorRef.current = id;
    }, []);

    const toggle = useCallback((id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
        anchorRef.current = id;
    }, []);

    const selectRange = useCallback(
        (toId: string) => {
            const anchor = anchorRef.current;
            if (!anchor) {
                setSelectedIds(new Set([toId]));
                anchorRef.current = toId;
                return;
            }
            const anchorIndex = items.findIndex((i) => getId(i) === anchor);
            const toIndex = items.findIndex((i) => getId(i) === toId);
            if (anchorIndex === -1 || toIndex === -1) return;

            const start = Math.min(anchorIndex, toIndex);
            const end = Math.max(anchorIndex, toIndex);
            const ids = new Set<string>();
            for (let i = start; i <= end; i++) {
                ids.add(getId(items[i]));
            }
            setSelectedIds(ids);
        },
        [items, getId],
    );

    const selectAll = useCallback(() => {
        setSelectedIds(new Set(items.map(getId)));
    }, [items, getId]);

    // Set the whole selection to an explicit subset (leaves the anchor untouched, like selectAll).
    const setSelection = useCallback((ids: string[]) => {
        setSelectedIds(new Set(ids));
    }, []);

    const clearSelection = useCallback(() => {
        setSelectedIds(new Set());
        anchorRef.current = null;
    }, []);

    const handleItemClick = useCallback(
        (id: string, e: React.MouseEvent) => {
            if (e.shiftKey) selectRange(id);
            else if (e.metaKey || e.ctrlKey) toggle(id);
            else select(id);
        },
        [select, toggle, selectRange],
    );

    const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

    const selectedItems = useMemo(
        () => items.filter((item) => selectedIds.has(getId(item))),
        [items, selectedIds, getId],
    );

    return {
        selectedIds,
        isSelected,
        selectedItems,
        selectedCount: selectedItems.length,
        hasSelection: selectedItems.length > 0,
        select,
        toggle,
        selectRange,
        selectAll,
        setSelection,
        clearSelection,
        handleItemClick,
    };
}
