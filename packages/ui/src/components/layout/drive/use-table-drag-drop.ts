import {useCallback, useState} from "react";
import {DrivePath} from "@workspace/lib/types/drive";

interface UseTableDragDropProps {
    onMove?: (item: DrivePath, targetItemId: string) => void;
}

export function useTableDragDrop({onMove}: UseTableDragDropProps) {
    const [draggedItem, setDraggedItem] = useState<DrivePath | null>(null);
    const [dragOverItem, setDragOverItem] = useState<string | null>(null);
    const [isValidDropTarget, setIsValidDropTarget] = useState(false);

    const isValidDrop = useCallback((source: DrivePath, target: DrivePath): boolean => {
        if (source.id === target.id) return false;
        if (target.type !== 'folder') return false;
        return true;
    }, []);

    const handleDragStart = useCallback((e: React.DragEvent, item: DrivePath) => {
        setDraggedItem(item);
        e.dataTransfer.setData('text/plain', item.id);
        e.dataTransfer.setData('application/eigen', JSON.stringify({
            id: item.id,
            type: item.type
        }));
        e.dataTransfer.effectAllowed = 'move';
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, item: DrivePath) => {
        e.preventDefault();
        if (!draggedItem) return;

        const isValid = isValidDrop(draggedItem, item);
        e.dataTransfer.dropEffect = isValid ? 'move' : 'none';
    }, [draggedItem, isValidDrop]);

    const handleDragEnter = useCallback((item: DrivePath) => {
        if (!draggedItem) return;
        setDragOverItem(item.id);
        setIsValidDropTarget(isValidDrop(draggedItem, item));
    }, [draggedItem, isValidDrop]);

    const handleDragLeave = useCallback(() => {
        // Intentionally empty - state cleared on drop/end
    }, []);

    const handleDrop = useCallback((e: React.DragEvent, targetItem: DrivePath) => {
        e.preventDefault();
        if (!draggedItem) return;

        if (isValidDrop(draggedItem, targetItem)) {
            onMove?.(draggedItem, targetItem.id);
        }

        setDraggedItem(null);
        setDragOverItem(null);
        setIsValidDropTarget(false);
    }, [draggedItem, isValidDrop, onMove]);

    const handleDragEnd = useCallback(() => {
        setDraggedItem(null);
        setDragOverItem(null);
        setIsValidDropTarget(false);
    }, []);

    return {
        draggedItem,
        dragOverItem,
        isValidDropTarget,
        handleDragStart,
        handleDragOver,
        handleDragEnter,
        handleDragLeave,
        handleDrop,
        handleDragEnd,
    };
}
