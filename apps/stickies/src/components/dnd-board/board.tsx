import {useState} from 'react';
import {DndContext, DragOverlay, PointerSensor, useSensor, useSensors} from '@dnd-kit/core';
import {horizontalListSortingStrategy, SortableContext} from '@dnd-kit/sortable';
import {Column} from './column';
import {TaskItem} from './types';
import {AddTaskDialog} from './add-task-dialog';
import {AddColumnDialog} from './add-column-dialog';
import {ColumnSettingsDialog} from './column-settings-dialog';
import {Plus} from 'lucide-react';
import {useIsMobile} from "@workspace/lib/media";
import {useYjsKanbanBoard} from './hooks/useYjsKanbanBoard';
import {useYjsDragAndDrop} from './hooks/useYjsDragAndDrop';
import { StickiesToolbar } from './stickies-toolbar';

interface StickiesBoardProps {
    ownerId: string;
    pathId: string;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
}

const StickiesBoard = ({ownerId, pathId, canWrite, onAccessDialogOpen}: StickiesBoardProps) => {
    // Core board state and operations with Yjs integration
    const {
        board,
        selectedColumnId,
        isAddTaskDialogOpen,
        setIsAddTaskDialogOpen,
        isAddColumnDialogOpen,
        setIsAddColumnDialogOpen,
        handleAddTaskClick,
        handleAddTask,
        handleAddColumn,
        yjsDoc,
        undoManager
    } = useYjsKanbanBoard(ownerId, pathId);

    // Drag and drop functionality with Yjs awareness
    const {
        dragState,
        handleDragStart,
        handleDragEnd,
    } = useYjsDragAndDrop({board, yjsDoc});

    // Refs and responsive hooks
    const isMobile = useIsMobile();

    // State for column editing
    const [editColumnId, setEditColumnId] = useState<string | null>(null);
    const [isColumnSettingsOpen, setIsColumnSettingsOpen] = useState(false);

    // Handle column edit button click
    const handleEditColumn = (columnId: string) => {
        setEditColumnId(columnId);
        setIsColumnSettingsOpen(true);
    };

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
            const task = dragState.activeItem as TaskItem;
            return (
                <div className={`${isMobile ? 'w-full' : 'w-[260px]'} border border-gray-200 shadow-sm bg-white`}>
                    <div className="py-1.5 px-2 text-sm bg-blue-50">
                        {task.title}
                        {task.description && (
                            <p className="text-xs text-gray-500 mt-1 truncate">{task.description}</p>
                        )}
                    </div>
                </div>
            );
        } else if (dragState.activeType === 'column') {
            const column = dragState.activeItem as import('./types').ColumnItem;
            const columnTasks = column.taskIds.map((taskId: string) => board.tasks[taskId]);
            return (
                <Column
                    column={column}
                    tasks={columnTasks}
                    onAddTask={handleAddTaskClick}
                    onEditColumn={handleEditColumn}
                    isMobile={isMobile}
                    yjsDoc={yjsDoc}
                    ownerId={ownerId}
                    comments={board.comments}
                />
            );
        }

        return null;
    };

    return (
<>
        <StickiesToolbar canWrite={canWrite} undoManager={undoManager} onAccessDialogOpen={onAccessDialogOpen} />
        <div className="h-full w-full flex bg-gray-200 overflow-hidden">
        <div
            className="overflow-x-auto overflow-y-hidden flex-1"
            style={board.columnOrder.length > 1 ? {
                padding: isMobile ? 0 : '0.75rem',
                scrollSnapType: 'x mandatory',
                scrollBehavior: 'smooth',
            } : {
                visibility: 'hidden',
            }}
        >
            <DndContext
                sensors={sensors}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                autoScroll={{
                    enabled:true,
                    threshold: {
                        x: 0.2,
                        y: 0.2
                    },
                    acceleration: 10,
                    interval: 10,
                    layoutShiftCompensation: false,
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
                                    onEditColumn={handleEditColumn}
                                    isMobile={isMobile}
                                    yjsDoc={yjsDoc}
                                    ownerId={ownerId}
                                    comments={board.comments}
                                />
                            );
                        })}
                    </SortableContext>

                    {/* Add Column Button */}
                    <div
                        className={`${isMobile ? 'mx-[4vw] min-w-[92vw] w-[92vw]' : 'mx-1.5 min-w-[280px] w-[280px]'} flex items-start h-full`}
                        style={{
                            scrollSnapAlign: 'center',
                            scrollSnapStop: 'normal'
                        }}
                    >
                        <button
                            onClick={() => setIsAddColumnDialogOpen(true)}
                            className="bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded text-sm flex items-center gap-1 py-2 px-4 text-gray-700 w-full"
                        >
                            <Plus size={16}/>
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

            {/* Column settings dialog */}
            {editColumnId && (
                <ColumnSettingsDialog
                    isOpen={isColumnSettingsOpen}
                    onClose={() => setIsColumnSettingsOpen(false)}
                    columnId={editColumnId}
                    columnTitle={board.columns[editColumnId]?.title || ""}
                    yjsDoc={yjsDoc}
                />
            )}
        </div>
        </div>
        </>
    );
}
export { StickiesBoard };
