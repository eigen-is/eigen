import React, { useState } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Column } from './column';
import { TaskCard } from './task-card';
import { initialData } from './initial-data';
import { BoardData, BoardProps, TaskItem, ColumnItem } from './types';

export const KanbanBoard: React.FC<BoardProps> = ({ ownerId, pathId }) => {
  const [board, setBoard] = useState<BoardData>(initialData);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<'task' | 'column' | null>(null);
  const [activeItem, setActiveItem] = useState<any>(null);

  // Sensors config - enables drag and drop functionality
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 5px movement required before drag starts
      },
    })
  );

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
    const { active } = event;
    const { id } = active;
    
    setActiveId(id as string);
    
    // Determine if we're dragging a task or column
    if (id in board.tasks) {
      setActiveType('task');
      setActiveItem(board.tasks[id as string]);
    } else if (id in board.columns) {
      setActiveType('column');
      setActiveItem(board.columns[id as string]);
    }
  };

  // Handle drag over event - needed for task reordering and moving between columns
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    
    if (!over) return;
    
    const activeId = active.id as string;
    const overId = over.id as string;
    
    // Only handle task movements
    if (activeType !== 'task') return;
    
    // Find source and destination columns
    const sourceColumnId = findColumnOfTask(activeId);
    const isOverColumn = overId in board.columns;
    
    // If over column directly
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
      setActiveId(null);
      setActiveType(null);
      setActiveItem(null);
      return;
    }
    
    const activeId = active.id as string;
    const overId = over.id as string;
    
    // Handle column reordering
    if (activeType === 'column') {
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
    
    setActiveId(null);
    setActiveType(null);
    setActiveItem(null);
  };

  // Get active task or column for the drag overlay
  const getActiveComponent = () => {
    if (!activeId || !activeType || !activeItem) return null;
    
    if (activeType === 'task') {
      return <TaskCard task={activeItem as TaskItem} />;
    } else if (activeType === 'column') {
      const columnTasks = (activeItem as ColumnItem).taskIds.map(taskId => board.tasks[taskId]);
      return <Column column={activeItem as ColumnItem} tasks={columnTasks} />;
    }
    
    return null;
  };

  return (
    <div style={{ padding: '20px', overflowX: 'auto' }}>      
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div style={{ display: 'flex', padding: '10px 0' }}>
          <SortableContext
            items={board.columnOrder}
            strategy={horizontalListSortingStrategy}
          >
            {board.columnOrder.map((columnId) => {
              const column = board.columns[columnId];
              const columnTasks = column.taskIds.map((taskId) => board.tasks[taskId]);
              
              return (
                <Column
                  key={column.id}
                  column={column}
                  tasks={columnTasks}
                  isDropAnimating={activeType === 'task' && Boolean(activeId)}
                />
              );
            })}
          </SortableContext>
        </div>
        
        <DragOverlay adjustScale={true}>
          {getActiveComponent()}
        </DragOverlay>
      </DndContext>
    </div>
  );
};
