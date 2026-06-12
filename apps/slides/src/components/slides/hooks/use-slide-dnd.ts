import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { FileEventDetailsMap } from '@workspace/lib/types/file-history';
import { useState } from 'react';
import type * as Y from 'yjs';

type DragState = {
    activeId: string | null;
};

type UseSlideDndProps = {
    yjsDoc: Y.Doc | null;
    onRecordEvent?: (event: { eventType: 'slide-reordered'; details: FileEventDetailsMap['slide-reordered'] }) => void;
};

export const useSlideDnd = ({ yjsDoc, onRecordEvent }: UseSlideDndProps) => {
    const [dragState, setDragState] = useState<DragState>({ activeId: null });

    const handleDragStart = (event: DragStartEvent) => {
        setDragState({ activeId: event.active.id as string });
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || !yjsDoc) {
            setDragState({ activeId: null });
            return;
        }
        const activeId = active.id as string;
        const overId = over.id as string;

        if (activeId !== overId) {
            const slideOrderArray = yjsDoc.getArray('slideOrder');
            const reorderedTo = yjsDoc.transact(() => {
                const currentOrder = slideOrderArray.toArray() as string[];
                const oldIndex = currentOrder.indexOf(activeId);
                const newIndex = currentOrder.indexOf(overId);
                if (oldIndex !== -1 && newIndex !== -1) {
                    slideOrderArray.delete(0, slideOrderArray.length);
                    const newOrder = [...currentOrder];
                    newOrder.splice(oldIndex, 1);
                    newOrder.splice(newIndex, 0, activeId);
                    slideOrderArray.insert(0, newOrder);
                    return newIndex;
                }
                return null;
            });
            if (reorderedTo !== null) {
                onRecordEvent?.({
                    eventType: 'slide-reordered',
                    details: { slideId: activeId, newIndex: reorderedTo },
                });
            }
        }
        setDragState({ activeId: null });
    };

    return {
        dragState,
        handleDragStart,
        handleDragEnd,
    };
};
