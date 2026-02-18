import {useCallback, useState} from 'react';

type UseListDropTargetOptions = {
    acceptTypes: string[];
    onDrop: (data: {type: string; ids: string[]}) => void;
}

export function useListDropTarget({acceptTypes, onDrop}: UseListDropTargetOptions) {
    const [isOver, setIsOver] = useState(false);

    const getDropProps = useCallback(() => ({
        onDragOver: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes('application/eigen-drag')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            }
        },
        onDragEnter: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes('application/eigen-drag')) {
                e.preventDefault();
                setIsOver(true);
            }
        },
        onDragLeave: () => setIsOver(false),
        onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setIsOver(false);
            try {
                const raw = e.dataTransfer.getData('application/eigen-drag');
                const data = JSON.parse(raw);
                if (acceptTypes.includes(data.type)) {
                    onDrop(data);
                }
            } catch { /* ignore invalid drops */ }
        },
    }), [acceptTypes, onDrop]);

    return {isOver, getDropProps};
}
