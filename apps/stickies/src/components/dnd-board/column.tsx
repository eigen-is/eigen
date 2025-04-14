import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskCard } from './task-card';
import { ColumnItem, TaskItem } from './types';
import { Plus } from 'lucide-react';

interface ColumnProps {
  column: ColumnItem;
  tasks: TaskItem[];
  isDropAnimating?: boolean;
  onAddTask: (columnId: string) => void;
}

export const Column: React.FC<ColumnProps> = ({ 
  column, 
  tasks, 
  isDropAnimating,
  onAddTask
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: column.id,
    data: {
      type: 'column',
      column,
    },
  });

  // Get task IDs for SortableContext
  const taskIds = tasks.map(task => task.id);

  return (
    <div
      ref={setNodeRef}
      className={`m-1.5 flex flex-col w-[270px] border border-gray-200 shadow-sm bg-white ${isDragging ? 'opacity-10' : ''}`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition
      }}
    >
      <div
        className="px-2 cursor-grab touch-none font-medium text-sm border-b bg-gray-50"
        {...attributes}
        {...listeners}
      >
        {column.title}
      </div>
      <div 
        className={`p-1.5 flex-grow min-h-[300px] flex flex-col ${
          isDropAnimating ? 'bg-blue-50/10' : 'bg-white'
        }`}
      >
        <div className="flex-grow">
          <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
            {tasks.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </SortableContext>
        </div>
        
        <button 
          onClick={() => onAddTask(column.id)}
          className="mt-1 flex items-center gap-1 text-sm text-gray-600 hover:bg-gray-100 px-2 py-1 rounded-sm w-full"
        >
          <Plus size={16} />
          <span>Add a card</span>
        </button>
      </div>
    </div>
  );
};
