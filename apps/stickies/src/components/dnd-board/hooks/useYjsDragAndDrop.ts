import {useState} from 'react';
import * as Y from 'yjs';
import { DragEndEvent, DragOverEvent, DragStartEvent} from '@dnd-kit/core';
import {BoardData} from '../types';

export type DragState = {
    activeId: string | null;
    activeType: 'task' | 'column' | null;
    activeItem: any | null;
};

type UseYjsDragAndDropProps = {
    board: BoardData;
    setBoard: React.Dispatch<React.SetStateAction<BoardData>>;
    yjsDoc: Y.Doc | null;
};

export const useYjsDragAndDrop = ({board, setBoard, yjsDoc}: UseYjsDragAndDropProps) => {
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

    // Handle drag start event
    const handleDragStart = (event: DragStartEvent) => {
        const {active} = event;
        const {id} = active;

        const activeId = id as string;

        // Determine if we're dragging a task or column
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

    // Handle drag over event - needed for task reordering and moving between columns
    const handleDragOver = (event: DragOverEvent) => {
        const {active, over} = event;

        if (!over || !dragState.activeType || !yjsDoc) return;

        const activeId = active.id as string;
        const overId = over.id as string;

        // Only handle task movements in drag over for real-time feedback
        if (dragState.activeType !== 'task') return;

        // Find source and destination columns
        const sourceColumnId = findColumnOfTask(activeId);
        const isOverColumn = overId in board.columns;

        // If over a column directly (crucial for empty columns)
        if (isOverColumn) {
            if (sourceColumnId === overId) return; // Same column, nothing to do

            if (sourceColumnId) {
                // Update React state for visual feedback
                // We'll do the actual Yjs update in handleDragEnd
                setBoard(prev => {
                    const sourceColumn = prev.columns[sourceColumnId];
                    const destColumn = prev.columns[overId];

                    const newSourceTaskIds = sourceColumn.taskIds.filter(id => id !== activeId);
                    const newDestTaskIds = [...destColumn.taskIds, activeId];

                    return {
                        ...prev,
                        columns: {
                            ...prev.columns,
                            [sourceColumnId]: {
                                ...sourceColumn,
                                taskIds: newSourceTaskIds,
                            },
                            [overId]: {
                                ...destColumn,
                                taskIds: newDestTaskIds,
                            },
                        },
                    };
                });
            }
        }
        // If over another task
        else if (overId in board.tasks) {
            const overColumnId = findColumnOfTask(overId);

            if (!sourceColumnId || !overColumnId) return;

            // Update React state for visual feedback
            // We'll do the actual Yjs update in handleDragEnd
            setBoard(prev => {
                // Handle same column reordering
                if (sourceColumnId === overColumnId) {
                    const column = prev.columns[sourceColumnId];
                    const currentTaskIds = [...column.taskIds];
                    const sourceIndex = currentTaskIds.indexOf(activeId);
                    const destinationIndex = currentTaskIds.indexOf(overId);

                    // Remove the item
                    currentTaskIds.splice(sourceIndex, 1);
                    // Add it at the new position
                    currentTaskIds.splice(destinationIndex, 0, activeId);

                    return {
                        ...prev,
                        columns: {
                            ...prev.columns,
                            [sourceColumnId]: {
                                ...column,
                                taskIds: currentTaskIds,
                            },
                        },
                    };
                }
                // Handle moving between columns
                else {
                    const sourceColumn = prev.columns[sourceColumnId];
                    const destColumn = prev.columns[overColumnId];

                    const sourceTaskIds = [...sourceColumn.taskIds];
                    const destTaskIds = [...destColumn.taskIds];

                    const sourceIndex = sourceTaskIds.indexOf(activeId);
                    const destIndex = destTaskIds.indexOf(overId);

                    // Remove from source column
                    sourceTaskIds.splice(sourceIndex, 1);

                    // Add to destination column at the specific position
                    destTaskIds.splice(destIndex, 0, activeId);

                    return {
                        ...prev,
                        columns: {
                            ...prev.columns,
                            [sourceColumnId]: {
                                ...sourceColumn,
                                taskIds: sourceTaskIds,
                            },
                            [overColumnId]: {
                                ...destColumn,
                                taskIds: destTaskIds,
                            },
                        },
                    };
                }
            });
        }
    };

    // Handle drag end event - commit changes to Yjs document
    const handleDragEnd = (event: DragEndEvent) => {
        const {active, over} = event;

        // Exit if no valid drop or no Yjs document
        if (!over || !yjsDoc) {
            setDragState({
                activeId: null,
                activeType: null,
                activeItem: null,
            });
            return;
        }

        const activeId = active.id as string;
        const overId = over.id as string;

        // Get Yjs shared types
        const columnsMap = yjsDoc.getMap('columns');
        const columnOrderArray = yjsDoc.getArray('columnOrder');

        yjsDoc.transact(() => {
            // Handle column reordering
            if (dragState.activeType === 'column') {
                if (activeId !== overId) {
                    // Get current column order
                    const currentOrder = columnOrderArray.toArray() as string[];
                    const oldIndex = currentOrder.indexOf(activeId);
                    const newIndex = currentOrder.indexOf(overId);

                    if (oldIndex !== -1 && newIndex !== -1) {
                        // Clear column order array
                        columnOrderArray.delete(0, columnOrderArray.length);

                        // Create new order by moving the column
                        const newOrder = [...currentOrder];
                        newOrder.splice(oldIndex, 1);
                        newOrder.splice(newIndex, 0, activeId);

                        // Insert the new order
                        columnOrderArray.insert(0, newOrder);
                    }
                }
            }
            // Handle task drops
            else if (dragState.activeType === 'task') {
                const sourceColumnId = findColumnOfTask(activeId);

                // If dropping directly on a column
                if (overId in board.columns && sourceColumnId && sourceColumnId !== overId) {
                    // Get the Y.Map for source and destination columns
                    const sourceColumnValue = columnsMap.get(sourceColumnId);
                    const destColumnValue = columnsMap.get(overId);

                    if (sourceColumnValue && destColumnValue) {
                        // Safely cast to Y.Map
                        const sourceColumn = sourceColumnValue as Y.Map<any>;
                        const destColumn = destColumnValue as Y.Map<any>;

                        // Get taskIds arrays
                        const sourceTaskIdsValue = sourceColumn.get('taskIds');
                        const destTaskIdsValue = destColumn.get('taskIds');

                        if (sourceTaskIdsValue && destTaskIdsValue) {
                            const sourceTaskIds = sourceTaskIdsValue as Y.Array<any>;
                            const destTaskIds = destTaskIdsValue as Y.Array<any>;

                            // Find index of the task in source
                            const sourceArray = sourceTaskIds.toArray() as string[];
                            const taskIndex = sourceArray.indexOf(activeId);

                            if (taskIndex !== -1) {
                                // Remove from source
                                sourceTaskIds.delete(taskIndex, 1);

                                // Add to destination
                                destTaskIds.push([activeId]);
                            }
                        }
                    }
                }
                // If dropping on another task
                else if (overId in board.tasks && sourceColumnId) {
                    const overColumnId = findColumnOfTask(overId);

                    if (overColumnId) {
                        // Get the relevant columns
                        const sourceColumnValue = columnsMap.get(sourceColumnId);
                        const overColumnValue = columnsMap.get(overColumnId);

                        if (sourceColumnValue && overColumnValue) {
                            // Safely cast to Y.Map
                            const sourceColumn = sourceColumnValue as Y.Map<any>;
                            const overColumn = overColumnValue as Y.Map<any>;

                            // Get taskIds arrays
                            const sourceTaskIdsValue = sourceColumn.get('taskIds');
                            const overTaskIdsValue = overColumn.get('taskIds');

                            if (sourceTaskIdsValue && overTaskIdsValue) {
                                const sourceTaskIds = sourceTaskIdsValue as Y.Array<any>;
                                const overTaskIds = overTaskIdsValue as Y.Array<any>;

                                // Get arrays to work with
                                const sourceArray = sourceTaskIds.toArray() as string[];
                                const overArray = overTaskIds.toArray() as string[];

                                const sourceIndex = sourceArray.indexOf(activeId);
                                const destIndex = overArray.indexOf(overId);

                                if (sourceIndex !== -1 && destIndex !== -1) {
                                    // If same column
                                    if (sourceColumnId === overColumnId) {
                                        // Remove at old position and insert at new position
                                        sourceTaskIds.delete(sourceIndex, 1);

                                        // Calculate insertion index based on whether we're moving forward or backward
                                        const insertAt = sourceIndex < destIndex ? destIndex : destIndex;
                                        sourceTaskIds.insert(insertAt, [activeId]);
                                    }
                                    // If different columns
                                    else {
                                        // Remove from source
                                        sourceTaskIds.delete(sourceIndex, 1);

                                        // Insert at destination
                                        overTaskIds.insert(destIndex, [activeId]);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        // Reset drag state
        setDragState({
            activeId: null,
            activeType: null,
            activeItem: null,
        });
    };

    return {
        dragState,
        findColumnOfTask,
        handleDragStart,
        handleDragOver,
        handleDragEnd
    };
};
