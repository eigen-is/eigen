import {useCallback, useState} from 'react';
import type {UseListSelectionReturn} from './use-list-selection';

type UseListDragOptions<T> = {
    selection: UseListSelectionReturn<T>;
    getId: (item: T) => string;
    dragType: string;
}

export function useListDrag<T>({selection, getId, dragType}: UseListDragOptions<T>) {
    const [isDragging, setIsDragging] = useState(false);
    const [draggedItems, setDraggedItems] = useState<T[]>([]);

    const getDragProps = useCallback((item: T) => ({
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
            if (!selection.isSelected(getId(item))) {
                selection.select(getId(item));
            }
            const items = selection.selectedItems.length > 0 ? selection.selectedItems : [item];
            setDraggedItems(items);
            setIsDragging(true);

            e.dataTransfer.setData('application/eigen-drag', JSON.stringify({
                type: dragType,
                ids: items.map(getId),
            }));
            e.dataTransfer.effectAllowed = 'move';

            if (items.length > 1) {
                const badge = document.createElement('div');
                badge.textContent = `${items.length} items`;
                badge.className = 'drag-badge';
                document.body.appendChild(badge);
                e.dataTransfer.setDragImage(badge, 0, 0);
                requestAnimationFrame(() => document.body.removeChild(badge));
            }
        },
        onDragEnd: () => {
            setIsDragging(false);
            setDraggedItems([]);
        },
    }), [selection, getId, dragType]);

    return {isDragging, draggedItems, getDragProps};
}
