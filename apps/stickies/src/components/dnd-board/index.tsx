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
import { AddTaskDialog } from './add-task-dialog';
import { AddColumnDialog } from './add-column-dialog';
import { Plus } from 'lucide-react';

export const KanbanBoard: React.FC<BoardProps> = ({ ownerId, pathId }) => {
  const [board, setBoard] = useState<BoardData>(initialData);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<'task' | 'column' | null>(null);
  const [activeItem, setActiveItem] = useState<any>(null);
  
  // Dialog states
  const [isAddTaskDialogOpen, setIsAddTaskDialogOpen] = useState(false);
  const [isAddColumnDialogOpen, setIsAddColumnDialogOpen] = useState(false);
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);

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
      return (
        <Column 
          column={activeItem as ColumnItem} 
          tasks={columnTasks} 
          onAddTask={handleAddTaskClick}
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
    <div className="p-3 overflow-x-auto">      
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-1">
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
                  onAddTask={handleAddTaskClick}
                />
              );
            })}
          </SortableContext>
          
          {/* Add Column Button */}
          <div className="m-1.5 w-[270px] flex items-start">
            <button 
              onClick={() => setIsAddColumnDialogOpen(true)}
              className="bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded text-sm flex items-center gap-1 py-2 px-4 text-gray-700"
            >
              <Plus size={16} />
              <span>Add another list</span>
            </button>
          </div>
        </div>
        
        <DragOverlay adjustScale={true}>
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
