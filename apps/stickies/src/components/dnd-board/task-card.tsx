import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskItem } from './types';

interface TaskCardProps {
  task: TaskItem;
}

export const TaskCard: React.FC<TaskCardProps> = ({ task }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: {
      type: 'task',
      task,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    backgroundColor: isDragging ? '#e0f7fa' : 'white',
    borderColor: isDragging ? '#4dabf5' : '#e0e0e0',
    cursor: 'grab',
    padding: '12px',
    margin: '0 0 8px 0',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: '4px',
    boxShadow: isDragging ? '0 5px 10px rgba(0,0,0,0.15)' : '0 1px 3px rgba(0,0,0,0.1)',
    userSelect: 'none',
    minHeight: '50px',
    width: '100%',
    position: 'relative',
    zIndex: isDragging ? 1 : 0,
    touchAction: 'none',
  } as React.CSSProperties;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      {task.content}
    </div>
  );
};
