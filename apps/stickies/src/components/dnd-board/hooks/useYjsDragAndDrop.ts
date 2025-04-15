import {useState} from 'react';
import * as Y from 'yjs';
import { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { BoardData, TaskItem, ColumnItem } from '../types';

type DragState = {
    activeId: string | null;
    activeType: 'task' | 'column' | null;
    activeItem: TaskItem | ColumnItem | null;
};

type UseYjsDragAndDropProps = {
    board: BoardData;
    yjsDoc: Y.Doc | null;
};

export const useYjsDragAndDrop = ({ board, yjsDoc }: UseYjsDragAndDropProps) => {
    const [dragState, setDragState] = useState<DragState>({
        activeId: null,
        activeType: null,
        activeItem: null,
    });

    // Find which column contains a task
    const findColumnOfTask = (taskId: string): string | null => {
        for (const columnId in board.columns) {
            const column = board.columns[columnId];
            if (column.taskIds.includes(taskId)) {
                return columnId;
            }
        }
        return null;
    };

    // Reset drag state utility
    const resetDragState = () => setDragState({ activeId: null, activeType: null, activeItem: null });

    // Handle drag start event
    const handleDragStart = (event: DragStartEvent) => {
        const { active } = event;
        const { id } = active;
        const activeId = id as string;
        if (activeId in board.tasks) {
            setDragState({
                activeId,
                activeType: 'task',
                activeItem: board.tasks[activeId],
            });
        } else if (activeId in board.columns) {
            setDragState({
                activeId,
                activeType: 'column',
                activeItem: board.columns[activeId],
            });
        }
    };

    // Only update Yjs state on drag end (no more React state updates for preview)
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
                        const sourceColumn = sourceColumnValue as Y.Map<any>;
                        const destColumn = destColumnValue as Y.Map<any>;
                        const sourceTaskIds = sourceColumn.get('taskIds') as Y.Array<any>;
                        const destTaskIds = destColumn.get('taskIds') as Y.Array<any>;
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
                            const sourceColumn = sourceColumnValue as Y.Map<any>;
                            const overColumn = overColumnValue as Y.Map<any>;
                            const sourceTaskIds = sourceColumn.get('taskIds') as Y.Array<any>;
                            const overTaskIds = overColumn.get('taskIds') as Y.Array<any>;
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
