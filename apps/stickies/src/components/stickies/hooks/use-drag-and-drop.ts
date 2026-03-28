import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { useState } from 'react';
import type * as Y from 'yjs';
import { normalizeBoard } from '../normalize-board';
import type { BoardData, CardItem, ColumnItem } from '../types';

type DragState = {
    activeId: string | null;
    activeType: 'task' | 'column' | null;
    activeItem: CardItem | ColumnItem | null;
};

type UseDragAndDropProps = {
    board: BoardData;
    yjsDoc: Y.Doc | null;
};

export const useDragAndDrop = ({ board, yjsDoc }: UseDragAndDropProps) => {
    const [dragState, setDragState] = useState<DragState>({
        activeId: null,
        activeType: null,
        activeItem: null,
    });

    const findColumnOfTask = (taskId: string): string | null => {
        for (const columnId in board.columns) {
            if (board.columns[columnId].taskIds.includes(taskId)) return columnId;
        }
        return null;
    };

    const resetDragState = () => setDragState({ activeId: null, activeType: null, activeItem: null });

    const handleDragStart = (event: DragStartEvent) => {
        const activeId = event.active.id as string;
        if (activeId in board.tasks) {
            setDragState({ activeId, activeType: 'task', activeItem: board.tasks[activeId] });
        } else if (activeId in board.columns) {
            setDragState({ activeId, activeType: 'column', activeItem: board.columns[activeId] });
        }
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || !yjsDoc) {
            resetDragState();
            return;
        }
        const activeId = active.id as string;
        const overId = over.id as string;
        const columnsMap = yjsDoc.getMap('columns');
        const columnOrderArray = yjsDoc.getArray('columnOrder');

        yjsDoc.transact(() => {
            if (dragState.activeType === 'column') {
                if (activeId !== overId) {
                    const currentOrder = columnOrderArray.toArray() as string[];
                    const oldIndex = currentOrder.indexOf(activeId);
                    const newIndex = currentOrder.indexOf(overId);
                    if (oldIndex !== -1 && newIndex !== -1) {
                        columnOrderArray.delete(0, columnOrderArray.length);
                        const newOrder = [...currentOrder];
                        newOrder.splice(oldIndex, 1);
                        newOrder.splice(newIndex, 0, activeId);
                        columnOrderArray.insert(0, newOrder);
                    }
                }
            } else if (dragState.activeType === 'task') {
                const sourceColumnId = findColumnOfTask(activeId);
                if (overId in board.columns && sourceColumnId && sourceColumnId !== overId) {
                    const sourceColumnValue = columnsMap.get(sourceColumnId);
                    const destColumnValue = columnsMap.get(overId);
                    if (sourceColumnValue && destColumnValue) {
                        const sourceTaskIds = (sourceColumnValue as Y.Map<unknown>).get('taskIds') as Y.Array<string>;
                        const destTaskIds = (destColumnValue as Y.Map<unknown>).get('taskIds') as Y.Array<string>;
                        const sourceArray = sourceTaskIds.toArray() as string[];
                        const taskIndex = sourceArray.indexOf(activeId);
                        if (taskIndex !== -1) {
                            sourceTaskIds.delete(taskIndex, 1);
                            destTaskIds.push([activeId]);
                        }
                    }
                } else if (overId in board.tasks && sourceColumnId) {
                    const overColumnId = findColumnOfTask(overId);
                    if (overColumnId) {
                        const sourceColumnValue = columnsMap.get(sourceColumnId);
                        const overColumnValue = columnsMap.get(overColumnId);
                        if (sourceColumnValue && overColumnValue) {
                            const sourceTaskIds = (sourceColumnValue as Y.Map<unknown>).get(
                                'taskIds',
                            ) as Y.Array<string>;
                            const overTaskIds = (overColumnValue as Y.Map<unknown>).get('taskIds') as Y.Array<string>;
                            const sourceArray = sourceTaskIds.toArray() as string[];
                            const overArray = overTaskIds.toArray() as string[];
                            const sourceIndex = sourceArray.indexOf(activeId);
                            const destIndex = overArray.indexOf(overId);
                            if (sourceIndex !== -1 && destIndex !== -1) {
                                if (sourceColumnId === overColumnId) {
                                    sourceTaskIds.delete(sourceIndex, 1);
                                    sourceTaskIds.insert(destIndex, [activeId]);
                                } else {
                                    sourceTaskIds.delete(sourceIndex, 1);
                                    overTaskIds.insert(destIndex, [activeId]);
                                }
                            }
                        }
                    }
                }
            }
            normalizeBoard(yjsDoc);
        });
        resetDragState();
    };

    return {
        dragState,
        findColumnOfTask,
        handleDragStart,
        handleDragEnd,
    };
};
