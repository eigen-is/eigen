import React from 'react';
import {useSortable} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {TaskItem} from './types';

interface TaskCardProps {
    task: TaskItem;
    isMobile: boolean;
}

export const TaskCard: React.FC<TaskCardProps> = ({task, isMobile}) => {
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

    // Use fixed widths on desktop, percentage width on mobile
    const width = isMobile ? 'w-full' : 'w-[260px]';

    return (
        <div
            ref={setNodeRef}
            className={`mb-1.5 ${width} border border-gray-200 shadow-sm bg-white select-none ${isDragging ? 'opacity-50' : ''}`}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                zIndex: isDragging ? 10 : 0,
            }}
            {...attributes}
            {...listeners}
        >
            <div className={`py-1.5 px-2 cursor-grab touch-none text-sm ${isDragging ? 'bg-blue-50' : 'bg-white'}`}>
                {task.title}
                {task.description && (
                    <p className="text-xs text-gray-500 mt-1 truncate">{task.description}</p>
                )}
            </div>
        </div>
    );
};
