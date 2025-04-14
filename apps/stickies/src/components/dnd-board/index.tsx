import React, { useRef } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Column } from './column';
import { BoardProps, TaskItem } from './types';
import { AddTaskDialog } from './add-task-dialog';
import { AddColumnDialog } from './add-column-dialog';
import { Plus } from 'lucide-react';
import { useIsMobile } from "@workspace/lib/media";
import { useYjsKanbanBoard } from './hooks/useYjsKanbanBoard';
import { useYjsDragAndDrop } from './hooks/useYjsDragAndDrop';

export const KanbanBoard: React.FC<BoardProps> = ({ ownerId, pathId }) => {
  // Core board state and operations with Yjs integration
  const {
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
    yjsDoc
  } = useYjsKanbanBoard(ownerId, pathId);
  
  // Drag and drop functionality with Yjs awareness
  const {
    dragState,
    collisionDetectionStrategy,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  } = useYjsDragAndDrop({ board, setBoard, yjsDoc });

  // Refs and responsive hooks
  const boardRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  
  // Sensors config - enables drag and drop functionality
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 5px movement required before drag starts
      },
    })
  );

  // Get active task or column for the drag overlay
  const getActiveComponent = () => {
    if (!dragState.activeId || !dragState.activeType || !dragState.activeItem) return null;
    
    if (dragState.activeType === 'task') {
      // Return a direct div for tasks, not a sortable component
      return (
        <div className={`${isMobile ? 'w-full' : 'w-[260px]'} border border-gray-200 shadow-sm bg-white`}>
          <div className="py-1.5 px-2 text-sm bg-blue-50">
            {(dragState.activeItem as TaskItem).title}
            {(dragState.activeItem as TaskItem).description && (
              <p className="text-xs text-gray-500 mt-1 truncate">{(dragState.activeItem as TaskItem).description}</p>
            )}
          </div>
        </div>
      );
    } else if (dragState.activeType === 'column') {
      const columnTasks = dragState.activeItem.taskIds.map((taskId: string) => board.tasks[taskId]);
      return (
        <Column 
          column={dragState.activeItem} 
          tasks={columnTasks} 
          onAddTask={handleAddTaskClick}
          isMobile={isMobile}
        />
      );
    }
    
    return null;
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
