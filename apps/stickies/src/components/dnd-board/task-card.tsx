import React, { useState } from 'react';
import {useSortable} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {TaskItem, CommentItem} from './types';
import { TaskInfoDialog } from './task-info-dialog';
import * as Y from 'yjs';

interface TaskCardProps {
    task: TaskItem;
    isMobile: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    comments: Record<string, CommentItem>;
}

export const TaskCard: React.FC<TaskCardProps> = ({task, isMobile, yjsDoc, ownerId, comments}) => {
    const [isInfoDialogOpen, setIsInfoDialogOpen] = useState(false);
    
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

    const handleCardClick = (e: React.MouseEvent) => {
        // Only open dialog if not dragging
        if (!isDragging) {
            e.stopPropagation();
            setIsInfoDialogOpen(true);
        }
    };

    return (
        <>
            <div
                ref={setNodeRef}
                className={`mb-1.5 w-full border border-gray-200 shadow-sm bg-white select-none ${isDragging ? 'opacity-50' : ''}`}
                style={{
                    transform: CSS.Transform.toString(transform),
                    transition,
                    zIndex: isDragging ? 10 : 0,
                }}
                {...attributes}
                {...listeners}
                onClick={handleCardClick}
            >
                <div className={`py-1.5 px-2 cursor-grab touch-none text-sm ${isDragging ? 'bg-blue-50' : 'bg-white'}`}>
                    {task.title}
                    {task.description && (
                        <p className="text-xs text-gray-500 mt-1 truncate">{task.description}</p>
                    )}
                </div>
            </div>

            <TaskInfoDialog
                isOpen={isInfoDialogOpen}
                onClose={() => setIsInfoDialogOpen(false)}
                task={task}
                yjsDoc={yjsDoc}
                ownerId={ownerId}
                comments={comments}
            />
        </>
    );
};
