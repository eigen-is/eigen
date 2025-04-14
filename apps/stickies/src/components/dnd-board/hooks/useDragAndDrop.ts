import React from 'react';
import { useState } from 'react';
import {
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  closestCorners,
  pointerWithin,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { BoardData, TaskItem } from '../types';

export type DragState = {
  activeId: string | null;
  activeType: 'task' | 'column' | null;
  activeItem: any | null;
};

type UseDragAndDropProps = {
  board: BoardData;
  setBoard: React.Dispatch<React.SetStateAction<BoardData>>;
};

export const useDragAndDrop = ({ board, setBoard }: UseDragAndDropProps) => {
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

  // Custom collision detection strategy - prioritize columns when dragging tasks
  const collisionDetectionStrategy = (args: any) => {
    // First, check for any collisions
    const pointerCollisions = pointerWithin(args);
    
    // When dragging a task, check if we're over a column
    if (dragState.activeType === 'task' && pointerCollisions.length > 0) {
      // Try to find any column collision in all collisions
      const columnCollision = pointerCollisions.find(collision => 
        collision.id in board.columns
      );
      
      // If we found a collision with a column, prioritize it
      if (columnCollision) {
        return [columnCollision];
      }
    }
    
    // If no column collision or not dragging a task, use default detection
    return closestCorners(args);
  };

  // Handle drag start event
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const { id } = active;
    
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
    const { active, over } = event;
    
    if (!over || !dragState.activeType) return;
    
    const activeId = active.id as string;
    const overId = over.id as string;
    
    // Only handle task movements
    if (dragState.activeType !== 'task') return;
    
    // Find source and destination columns
    const sourceColumnId = findColumnOfTask(activeId);
    const isOverColumn = overId in board.columns;
    
    // If over a column directly (crucial for empty columns)
    if (isOverColumn) {
      if (sourceColumnId === overId) return; // Same column, nothing to do
      
      if (sourceColumnId) {
        // Move the task to the end of the target column
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
      
      // Same column reordering
      if (sourceColumnId === overColumnId) {
        setBoard(prev => {
          const column = prev.columns[sourceColumnId];
          const currentTaskIds = [...column.taskIds];
          const sourceIndex = currentTaskIds.indexOf(activeId);
          const destinationIndex = currentTaskIds.indexOf(overId);
          
          const newTaskIds = arrayMove(
            currentTaskIds,
            sourceIndex,
            destinationIndex
          );
          
          return {
            ...prev,
            columns: {
              ...prev.columns,
              [sourceColumnId]: {
                ...column,
                taskIds: newTaskIds,
              },
            },
          };
        });
      } 
      // Different column
      else {
        setBoard(prev => {
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
        });
      }
    }
  };

  // Handle drag end event
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    
    if (!over) {
      setDragState({
        activeId: null,
        activeType: null,
        activeItem: null,
      });
      return;
    }
    
    const activeId = active.id as string;
    const overId = over.id as string;
    
    // Handle column reordering
    if (dragState.activeType === 'column') {
      if (activeId !== overId) {
        setBoard(prev => {
          const oldColumnOrder = [...prev.columnOrder];
          const oldIndex = oldColumnOrder.indexOf(activeId);
          const newIndex = oldColumnOrder.indexOf(overId);
          
          const newColumnOrder = arrayMove(oldColumnOrder, oldIndex, newIndex);
          
          return {
            ...prev,
            columnOrder: newColumnOrder,
          };
        });
      }
    }
    // Make sure we handle task drops on empty columns
    else if (dragState.activeType === 'task') {
      const sourceColumnId = findColumnOfTask(activeId);
      // Check if dropping directly on a column
      if (overId in board.columns && sourceColumnId && sourceColumnId !== overId) {
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
    
    setDragState({
      activeId: null,
      activeType: null,
      activeItem: null,
    });
  };

  return {
    dragState,
    findColumnOfTask,
    collisionDetectionStrategy,
    handleDragStart,
    handleDragOver,
    handleDragEnd
  };
};
