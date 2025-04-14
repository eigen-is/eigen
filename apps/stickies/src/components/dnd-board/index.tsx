import React, { useState, useRef } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  pointerWithin,
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
import { initialData } from './initial-data';
import { BoardData, BoardProps, TaskItem, ColumnItem } from './types';
import { AddTaskDialog } from './add-task-dialog';
import { AddColumnDialog } from './add-column-dialog';
import { Plus } from 'lucide-react';
import { useIsMobile } from "@workspace/lib/media";

export const KanbanBoard: React.FC<BoardProps> = ({ ownerId, pathId }) => {
  const [board, setBoard] = useState<BoardData>(initialData);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<'task' | 'column' | null>(null);
  const [activeItem, setActiveItem] = useState<any>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  
  // Dialog states
  const [isAddTaskDialogOpen, setIsAddTaskDialogOpen] = useState(false);
  const [isAddColumnDialogOpen, setIsAddColumnDialogOpen] = useState(false);
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);

  // Custom collision detection strategy - prioritize columns when dragging tasks
  const collisionDetectionStrategy = (args: any) => {
    // First, check for any collisions
    const pointerCollisions = pointerWithin(args);
    
    // When dragging a task, check if we're over a column
    if (activeType === 'task' && pointerCollisions.length > 0) {
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
    // Make sure we handle task drops on empty columns
    else if (activeType === 'task') {
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
    
    setActiveId(null);
    setActiveType(null);
    setActiveItem(null);
  };

  // Get active task or column for the drag overlay
  const getActiveComponent = () => {
    if (!activeId || !activeType || !activeItem) return null;
    
    if (activeType === 'task') {
      // Return a direct div for tasks, not a sortable component
      return (
        <div className={`w-[260px] border border-gray-200 shadow-sm bg-white`}>
          <div className="py-1.5 px-2 text-sm bg-blue-50">
            {(activeItem as TaskItem).title}
            {(activeItem as TaskItem).description && (
              <p className="text-xs text-gray-500 mt-1 truncate">{(activeItem as TaskItem).description}</p>
            )}
          </div>
        </div>
      );
    } else if (activeType === 'column') {
      const columnTasks = (activeItem as ColumnItem).taskIds.map(taskId => board.tasks[taskId]);
      return (
        <Column 
          column={activeItem as ColumnItem} 
          tasks={columnTasks} 
          onAddTask={handleAddTaskClick}
          isMobile={isMobile}
        />
      );
    }
    
    return null;
  };

  // Handle opening the add task dialog
  const handleAddTaskClick = (columnId: string) => {
    setSelectedColumnId(columnId);
    setIsAddTaskDialogOpen(true);
  };

  // Handle creating a new task
  const handleAddTask = (taskData: Omit<TaskItem, 'id' | 'comments'>) => {
    if (!selectedColumnId) return;
    
    setBoard(prev => {
      // Create a new task ID
      const taskId = `task-${Date.now()}`;
      
      // Create the new task
      const newTask: TaskItem = {
        id: taskId,
        ...taskData,
        comments: []
      };
      
      // Add to the column
      const column = prev.columns[selectedColumnId];
      const updatedTaskIds = [...column.taskIds, taskId];
      
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: newTask
        },
        columns: {
          ...prev.columns,
          [selectedColumnId]: {
            ...column,
            taskIds: updatedTaskIds
          }
        }
      };
    });
  };

  // Handle creating a new column
  const handleAddColumn = (columnData: Omit<ColumnItem, 'id' | 'taskIds'>) => {
    setBoard(prev => {
      // Create a new column ID
      const columnId = `column-${Date.now()}`;
      
      // Create the new column
      const newColumn: ColumnItem = {
        id: columnId,
        ...columnData,
        taskIds: []
      };
      
      return {
        ...prev,
        columns: {
          ...prev.columns,
          [columnId]: newColumn
        },
        columnOrder: [...prev.columnOrder, columnId]
      };
    });
  };

  return (
    <div 
      ref={boardRef}
      className="overflow-x-auto h-[calc(100vh-64px)]"
      style={{ 
        padding: isMobile ? 0 : '0.75rem',
        scrollSnapType: 'x mandatory',
        scrollBehavior: 'smooth',
      }}
    >      
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetectionStrategy}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        autoScroll={{
          threshold: {
            x: 0.2,
            y: 0.2
          },
          acceleration: 10,
          interval: 10
        }}
      >
        <div className={`flex ${isMobile ? 'gap-0' : 'gap-3'} h-full`}>
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
                  onAddTask={handleAddTaskClick}
                  isMobile={isMobile}
                />
              );
            })}
          </SortableContext>
          
          {/* Add Column Button */}
          <div 
            className={`${isMobile ? 'mx-[4vw] min-w-[92vw]' : 'mx-1.5 min-w-[280px] w-[280px]'} flex items-start h-full`}
            style={{
              scrollSnapAlign: 'center',
              scrollSnapStop: 'normal'
            }}
          >
            <button 
              onClick={() => setIsAddColumnDialogOpen(true)}
              className="bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded text-sm flex items-center gap-1 py-2 px-4 text-gray-700"
            >
              <Plus size={16} />
              <span>Add another list</span>
            </button>
          </div>
        </div>
        
        <DragOverlay adjustScale={false}>
          {getActiveComponent()}
        </DragOverlay>
      </DndContext>
      
      {/* Dialogs */}
      <AddTaskDialog 
        isOpen={isAddTaskDialogOpen} 
        onClose={() => setIsAddTaskDialogOpen(false)} 
        onAddTask={handleAddTask} 
        columnId={selectedColumnId}
      />
      
      <AddColumnDialog 
        isOpen={isAddColumnDialogOpen} 
        onClose={() => setIsAddColumnDialogOpen(false)} 
        onAddColumn={handleAddColumn}
      />
    </div>
  );
};
