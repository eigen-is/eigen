import {useState} from 'react';
import {useHotkey} from '@tanstack/react-hotkeys';
import {DndContext, DragOverlay, PointerSensor, useSensor, useSensors} from '@dnd-kit/core';
import {horizontalListSortingStrategy, SortableContext} from '@dnd-kit/sortable';
import {Column} from './column';
import {TaskItem} from './types';
import {AddTaskDialog} from './add-task-dialog';
import {AddColumnDialog} from './add-column-dialog';
import {ColumnSettingsDialog} from './column-settings-dialog';
import {Plus} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {Card, CardContent} from '@workspace/ui/components/card';
import {useIsMobile} from "@workspace/lib/media";
import {useYjsKanbanBoard} from './hooks/useYjsKanbanBoard';
import {useYjsDragAndDrop} from './hooks/useYjsDragAndDrop';
import {StickiesToolbar} from './stickies-toolbar';
import type {DrivePath} from '@workspace/lib/types/drive';

interface StickiesBoardProps {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
}

const StickiesBoard = ({ownerId, path, canWrite, chatFolderId, onAccessDialogOpen}: StickiesBoardProps) => {
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
    } = useYjsKanbanBoard(ownerId, path.mountId, path.id, chatFolderId);

    const {
        dragState,
        handleDragStart,
        handleDragEnd,
    } = useYjsDragAndDrop({board, yjsDoc});

    useHotkey('Mod+Z', (e) => {
        e.preventDefault();
        undoManager?.undo();
    }, {enabled: canWrite && !!undoManager});

    useHotkey('Mod+Y', (e) => {
        e.preventDefault();
        undoManager?.redo();
    }, {enabled: canWrite && !!undoManager});

    useHotkey('Mod+Shift+Z', (e) => {
        e.preventDefault();
        undoManager?.redo();
    }, {enabled: canWrite && !!undoManager});

    const isMobile = useIsMobile();

    const [editColumnId, setEditColumnId] = useState<string | null>(null);
    const [isColumnSettingsOpen, setIsColumnSettingsOpen] = useState(false);

    const handleEditColumn = (columnId: string) => {
        setEditColumnId(columnId);
        setIsColumnSettingsOpen(true);
    };

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5, // 5px movement required before drag starts
            },
        })
    );

    const getActiveComponent = () => {
        if (!dragState.activeId || !dragState.activeType || !dragState.activeItem) return null;

        if (dragState.activeType === 'task') {
            const task = dragState.activeItem as TaskItem;
            return (
                <Card className={`${isMobile ? 'w-full p-0' : 'w-[260px] p-0'}`}>
                    <CardContent className="p-3 text-sm bg-blue-50">
                        {task.title}
                        {task.description && (
                            <p className="text-xs text-muted-foreground mt-1 truncate">{task.description}</p>
                        )}
                    </CardContent>
                </Card>
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
                    mountId={path.mountId}
                />
            );
        }

        return null;
    };

    return (
        <div className="flex flex-col h-full w-full">
            <StickiesToolbar path={path} canWrite={canWrite} undoManager={undoManager}
                             onAccessDialogOpen={onAccessDialogOpen}/>
            <div className="flex-1 w-full flex bg-gray-200 overflow-hidden">
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
                            enabled: true,
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
                                            mountId={path.mountId}
                                        />
                                    );
                                })}
                            </SortableContext>

                            <div
                                className={`${isMobile ? 'mx-[4vw] min-w-[92vw] w-[92vw]' : 'mx-1.5 min-w-[280px] w-[280px]'} flex items-start h-full`}
                                style={{
                                    scrollSnapAlign: 'center',
                                    scrollSnapStop: 'normal'
                                }}
                            >
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setIsAddColumnDialogOpen(true)}
                                    className="w-full justify-start h-auto py-2"
                                >
                                    <Plus size={16}/>
                                    <span>Add Column</span>
                                </Button>
                            </div>
                        </div>

                        <DragOverlay adjustScale={false}>
                            {getActiveComponent()}
                        </DragOverlay>
                    </DndContext>

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
        </div>
    );
}
export {StickiesBoard};
