import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskCard } from './task-card';
import { ColumnItem, TaskItem } from './types';

interface ColumnProps {
  column: ColumnItem;
  tasks: TaskItem[];
  isDropAnimating?: boolean;
}

export const Column: React.FC<ColumnProps> = ({ column, tasks, isDropAnimating }) => {
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

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    margin: '0 8px',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#f9f9f9',
    borderRadius: '4px',
    border: '1px solid #e0e0e0',
    width: '280px',
    minHeight: '500px',
    zIndex: isDragging ? 1 : 0,
    touchAction: 'none',
  } as React.CSSProperties;

  const headerStyle = {
    padding: '12px',
    backgroundColor: isDragging ? '#e0f7fa' : '#f0f0f0',
    borderBottom: '1px solid #e0e0e0',
    fontWeight: 'bold',
    cursor: 'grab',
    touchAction: 'none',
    borderTopLeftRadius: '3px', 
    borderTopRightRadius: '3px',
  } as React.CSSProperties;

  const taskListStyle = {
    padding: '12px',
    flex: 1,
    minHeight: '100px',
    backgroundColor: isDropAnimating ? '#e6f7ff' : '#f9f9f9',
    transition: 'background-color 0.2s ease',
    borderBottomLeftRadius: '3px',
    borderBottomRightRadius: '3px',
  } as React.CSSProperties;

  // Get task IDs for SortableContext
  const taskIds = tasks.map(task => task.id);

  return (
    <div ref={setNodeRef} style={style}>
      <div style={headerStyle} {...attributes} {...listeners}>
        {column.title}
      </div>
      <div style={taskListStyle}>
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </SortableContext>
      </div>
    </div>
  );
};
