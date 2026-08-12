import type { DrivePath } from '@workspace/lib/types';
import type React from 'react';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboardListNavigation } from '../../../hooks/use-keyboard-list-navigation';
import { useListDrag } from '../../../hooks/use-list-drag';
import { type UseListSelectionReturn, useListSelection } from '../../../hooks/use-list-selection';
import { useSelectableContextMenu } from '../../../hooks/use-selectable-context-menu';

export type UseDriveItemControllerOptions = {
    // Already sorted by the caller — the controller selects/navigates over them as-is.
    items: DrivePath[];
    activeItemId?: string;
    // Grid width for keyboard navigation; DriveTable keeps the default single column.
    columns?: number;
    scrollToIndex?: (index: number, opts?: { align?: 'center' }) => void;
    containerRef: RefObject<HTMLElement | null>;
    // Selection lifted by the caller (DriveList) so it survives list/grid toggles.
    selection?: UseListSelectionReturn<DrivePath>;
    onItemClick?: (item: DrivePath) => void;
    onQuickLook?: (item: DrivePath) => void;
    onMove?: (item: DrivePath, targetItemId: string) => void;
    onSelectionChange?: (items: DrivePath[]) => void;
};

export function useDriveItemController({
    items,
    activeItemId,
    columns = 1,
    scrollToIndex,
    containerRef,
    selection: externalSelection,
    onItemClick,
    onQuickLook,
    onMove,
    onSelectionChange,
}: UseDriveItemControllerOptions) {
    const handleItemSelect = useCallback(
        (id: string) => {
            const item = items.find((i) => i.id === id);
            if (item) onItemClick?.(item);
        },
        [items, onItemClick],
    );

    const handleQuickLook = useCallback(
        (id: string) => {
            if (!onQuickLook) return;
            const item = items.find((i) => i.id === id);
            if (item) onQuickLook(item);
        },
        [items, onQuickLook],
    );

    const internalSelection = useListSelection({ items, getId: (item) => item.id });
    const selection = externalSelection ?? internalSelection;

    // A row picked through the URL (drive's `pid`) is a real selection, not just active-row
    // styling — the palette's selection actions and the shift-range anchor read the selection set.
    useEffect(() => {
        if (activeItemId) selection.select(activeItemId);
    }, [activeItemId, selection.select]);

    useEffect(() => {
        onSelectionChange?.(selection.selectedItems);
    }, [selection.selectedItems, onSelectionChange]);

    const { selectedIndex, handleKeyDown } = useKeyboardListNavigation<DrivePath>({
        items,
        activeId: activeItemId,
        getId: (item) => item.id,
        onSelect: handleItemSelect,
        onQuickLook: onQuickLook ? handleQuickLook : undefined,
        containerRef,
        shouldNotify: () => !!activeItemId,
        selection,
        columns,
        scrollToIndex,
    });

    // Scroll a deep-linked active item into view once on mount; later selects don't recenter.
    const initialActiveId = useRef(activeItemId);
    const didInitialScroll = useRef(false);
    useEffect(() => {
        if (didInitialScroll.current || !initialActiveId.current || !scrollToIndex) return;
        const idx = items.findIndex((i) => i.id === initialActiveId.current);
        if (idx >= 0) {
            scrollToIndex(idx, { align: 'center' });
            didInitialScroll.current = true;
        }
    }, [items, scrollToIndex]);

    const drag = useListDrag({ selection, getId: (item) => item.id, dragType: 'drive-item' });
    const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);

    // Right-click, the long-press (touch) opener, and the kebab button all select-then-open.
    const {
        contextMenu,
        handleContextMenu,
        openAt: openContextMenuAt,
        openFromButton: openContextMenuFromButton,
    } = useSelectableContextMenu({ selection, getId: (item) => item.id });

    const isValidFolderDrop = (targetItem: DrivePath) => {
        if (targetItem.type !== 'folder') return false;
        return !drag.draggedItems.some((d) => d.id === targetItem.id);
    };

    // Drop handlers for folder rows/tiles — spread onto the item root next to getDragProps.
    const getDropProps = (item: DrivePath) => ({
        onDragOver: (e: React.DragEvent) => {
            e.preventDefault();
            if (drag.isDragging && isValidFolderDrop(item)) {
                e.dataTransfer.dropEffect = 'move';
            }
        },
        onDragEnter: () => {
            if (drag.isDragging) setDragOverItemId(item.id);
        },
        onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setDragOverItemId(null);
            if (isValidFolderDrop(item)) {
                for (const d of drag.draggedItems) onMove?.(d, item.id);
            }
        },
    });

    return {
        selection,
        selectedIndex,
        handleKeyDown,
        drag,
        contextMenu,
        handleContextMenu,
        openContextMenuFromButton,
        openContextMenuAt,
        isValidFolderDrop,
        dragOverItemId,
        getDropProps,
    };
}
