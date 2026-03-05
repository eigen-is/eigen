import React, {useState} from 'react';
import {useSortable} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {TaskItem} from './types';
import {TaskInfoDialog} from './task-info-dialog';
import {Card, CardContent} from '@workspace/ui/components/card';
import * as Y from 'yjs';

interface TaskCardProps {
    task: TaskItem;
    isMobile: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    mountId: string;
}

export const TaskCard: React.FC<TaskCardProps> = ({task, isMobile, yjsDoc, ownerId, mountId}) => {
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
            <Card
                ref={setNodeRef}
                className={`mb-2 p-0 w-full select-none cursor-grab touch-none ${isDragging ? 'opacity-50' : ''}`}
                style={{
                    transform: CSS.Transform.toString(transform),
                    transition,
                    zIndex: isDragging ? 10 : 0,
                }}
                {...attributes}
                {...listeners}
                onClick={handleCardClick}
            >
                <CardContent className={`p-3 text-sm ${isDragging ? 'bg-blue-50' : ''}`}>
                    {task.title}
                    {task.description && (
                        <p className="text-xs text-muted-foreground mt-1 truncate">{task.description}</p>
                    )}
                </CardContent>
            </Card>

            <TaskInfoDialog
                isOpen={isInfoDialogOpen}
                onClose={() => setIsInfoDialogOpen(false)}
                task={task}
                yjsDoc={yjsDoc}
                ownerId={ownerId}
                mountId={mountId}
            />
        </>
    );
};
