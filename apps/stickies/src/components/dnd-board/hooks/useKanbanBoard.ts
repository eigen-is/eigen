import { useState } from 'react';
import { BoardData, TaskItem, ColumnItem } from '../types';
import { initialData } from '../initial-data';

export const useKanbanBoard = (_ownerId?: string | undefined, _pathId?: string | undefined) => {
  // NOTE: ownerId and pathId are preserved for future backend integration
  // They would be used to fetch and persist board data from the server
  
  const [board, setBoard] = useState<BoardData>(initialData);
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [isAddTaskDialogOpen, setIsAddTaskDialogOpen] = useState(false);
  const [isAddColumnDialogOpen, setIsAddColumnDialogOpen] = useState(false);

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

  return {
    board,
    setBoard,
    selectedColumnId,
    isAddTaskDialogOpen,
    setIsAddTaskDialogOpen,
    isAddColumnDialogOpen,
    setIsAddColumnDialogOpen,
    handleAddTaskClick,
    handleAddTask,
    handleAddColumn,
  };
};
