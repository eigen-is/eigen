import type { DrivePath } from '@workspace/lib/types';
import type React from 'react';
import { type RefObject, useCallback, useEffect, useState } from 'react';
import { useKeyboardListNavigation } from '../../../hooks/use-keyboard-list-navigation';
import { useListDrag } from '../../../hooks/use-list-drag';
import { useListSelection } from '../../../hooks/use-list-selection';
import { useContextMenu } from '../context-menu';

export type UseDriveItemControllerOptions = {
    // Already sorted by the caller — the controller selects/navigates over them as-is.
    items: DrivePath[];
    activeItemId?: string;
    // Forwarded to useKeyboardListNavigation so grid/list virtualizers can inject
    // grid width + a scroll callback. DriveTable passes neither (defaults: columns 1).
    columns?: number;
    scrollToIndex?: (index: number) => void;
    containerRef: RefObject<HTMLElement | null>;
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

    const selection = useListSelection({ items, getId: (item) => item.id });

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

    const drag = useListDrag({ selection, getId: (item) => item.id, dragType: 'drive-item' });
    const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);

    const contextMenu = useContextMenu<DrivePath>();

    const handleContextMenu = (e: React.MouseEvent, item: DrivePath) => {
        if (!selection.isSelected(item.id)) {
            selection.select(item.id);
        }
        contextMenu.handleContextMenu(e, item);
    };

    const openContextMenuFromButton = (button: HTMLElement, item: DrivePath) => {
        if (!selection.isSelected(item.id)) {
            selection.select(item.id);
        }
        const rect = button.getBoundingClientRect();
        contextMenu.openAt(item, rect.right, rect.bottom);
    };

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
        isValidFolderDrop,
        dragOverItemId,
        getDropProps,
    };
}
