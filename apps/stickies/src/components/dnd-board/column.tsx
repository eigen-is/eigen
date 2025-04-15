import React from 'react';
import {SortableContext, useSortable, verticalListSortingStrategy} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {TaskCard} from './task-card';
import {ColumnItem, TaskItem, CommentItem} from './types';
import {Plus} from 'lucide-react';
import * as Y from 'yjs';

interface ColumnProps {
    column: ColumnItem;
    tasks: TaskItem[];
    isDropAnimating?: boolean;
    onAddTask: (columnId: string) => void;
    isMobile: boolean;
    yjsDoc: Y.Doc | null;
    ownerId: string;
    comments: Record<string, CommentItem>;
}

export const Column: React.FC<ColumnProps> = ({
                                                  column,
                                                  tasks,
                                                  isDropAnimating,
                                                  onAddTask,
                                                  isMobile,
                                                  yjsDoc,
                                                  ownerId,
                                                  comments
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

    // Set width based on mobile or desktop
    const columnWidth = isMobile ? 'w-[92vw] min-w-[92vw]' : 'w-[280px] min-w-[280px]';
    const columnMargin = isMobile ? 'mx-[4vw]' : 'mx-1.5';

    return (
        <div
            ref={setNodeRef}
            className={`${columnMargin} ${columnWidth} flex flex-col border border-gray-200 shadow-sm ${isDragging ? 'opacity-10' : ''} h-full`}
            style={{
                transform: CSS.Transform.toString(transform),
                transition,
                scrollSnapAlign: 'center',
                scrollSnapStop: 'normal'
            }}
        >
            {/* Column header */}
            <div
                className="px-2 py-2 cursor-grab touch-none font-medium text-sm border-b bg-gray-50 flex-shrink-0"
                {...attributes}
                {...listeners}
            >
                {column.title}
            </div>

            {/* Column content area */}
            <div
                className={`flex-grow flex flex-col p-1.5 ${
                    isDropAnimating ? 'bg-blue-50/10' : 'bg-white'
                }`}
            >
                {tasks.length === 0 ? (
                    /* Special empty column state - this is crucial for dropping */
                    <div
                        className="flex-grow min-h-[150px] flex items-center justify-center"
                        data-column-id={column.id} // Add data attribute to help identify this element
                    >
                    </div>
                ) : (
                    /* Normal column with tasks */
                    <div className="flex-grow">
                        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
                            {tasks.map((task) => (
                                <TaskCard 
                                    key={task.id} 
                                    task={task} 
                                    isMobile={isMobile}
                                    yjsDoc={yjsDoc}
                                    ownerId={ownerId}
                                    comments={comments}
                                />
                            ))}
                        </SortableContext>
                    </div>
                )}

                {/* Add task button */}
                <button
                    onClick={() => onAddTask(column.id)}
                    className="mt-2 flex items-center gap-1 text-sm text-gray-600 hover:bg-gray-100 px-2 py-1.5 rounded-sm w-full"
                >
                    <Plus size={16}/>
                    <span>Add a sticky</span>
                </button>
            </div>
        </div>
    );
};
