import {useCallback, useState} from 'react';
import {useHotkey} from '@tanstack/react-hotkeys';
import {DndContext, DragOverlay, PointerSensor, useSensor, useSensors} from '@dnd-kit/core';
import {horizontalListSortingStrategy, SortableContext} from '@dnd-kit/sortable';
import {Column} from './column';
import {CardItem, ColumnItem} from './types';
import {AddCardDialog} from './add-card-dialog';
import {AddColumnDialog} from './add-column-dialog';
import {ColumnSettingsDialog} from './column-settings-dialog';
import {Card, CardContent} from '@workspace/ui/components/card';
import {isLightColor} from '@workspace/ui/components/layout/media/color-picker';
import {useIsMobile} from '@workspace/lib/media';
import {useBoard} from './hooks/use-board';
import {useDragAndDrop} from './hooks/use-drag-and-drop';
import {Toolbar} from './toolbar';
import type {DrivePath} from '@workspace/lib/types/drive';
import {MediaResolverProvider} from '@workspace/lib/drive';
import * as Y from 'yjs';

function jsonToYType(value: unknown): unknown {
    if (Array.isArray(value)) {
        const arr = new Y.Array();
        arr.push(value.map(jsonToYType));
        return arr;
    }
    if (value !== null && typeof value === 'object') {
        const map = new Y.Map();
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            map.set(k, jsonToYType(v));
        }
        return map;
    }
    return value;
}

type StickiesBoardProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
}

export function StickiesBoard({ownerId, path, canWrite, chatFolderId, onAccessDialogOpen}: StickiesBoardProps) {
    const {
        board,
        selectedColumnId,
        isAddCardDialogOpen,
        setIsAddCardDialogOpen,
        isAddColumnDialogOpen,
        setIsAddColumnDialogOpen,
        handleAddCardClick,
        handleAddCard,
        handleAddColumn,
        yjsDoc,
        undoManager,
    } = useBoard(ownerId, path.mountId, path.id, chatFolderId);

    const {
        dragState,
        handleDragStart,
        handleDragEnd,
    } = useDragAndDrop({board, yjsDoc});

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

    const handleRestore = useCallback((state: Uint8Array) => {
        if (!yjsDoc) return;
        const tempDoc = new Y.Doc();
        Y.applyUpdate(tempDoc, state);

        const allKeys = new Set([...yjsDoc.share.keys(), ...tempDoc.share.keys()]);

        yjsDoc.transact(() => {
            for (const key of allKeys) {
                const localType = yjsDoc.get(key);
                if (localType instanceof Y.Map) {
                    const json = tempDoc.getMap(key).toJSON();
                    for (const k of [...localType.keys()]) localType.delete(k);
                    for (const [k, v] of Object.entries(json)) {
                        localType.set(k, jsonToYType(v));
                    }
                } else if (localType instanceof Y.Array) {
                    const json = tempDoc.getArray(key).toJSON();
                    localType.delete(0, localType.length);
                    localType.push(json);
                }
            }
        });
        tempDoc.destroy();
    }, [yjsDoc]);

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {distance: 5},
        })
    );

    const getActiveComponent = () => {
        if (!dragState.activeId || !dragState.activeType || !dragState.activeItem) return null;

        if (dragState.activeType === 'task') {
            const card = dragState.activeItem as CardItem;
            return (
                <Card className={`${isMobile ? 'w-full p-0' : 'w-[260px] p-0'}`}
                      style={{
                          backgroundColor: card.color || undefined,
                          color: card.color ? (isLightColor(card.color) ? '#000' : '#fff') : undefined,
                      }}>
                    <CardContent className={`p-3 text-sm ${!card.color ? 'bg-accent' : ''}`}>
                        {card.title}
                        {card.description && (
                            <p className="text-xs mt-1 truncate" style={{opacity: 0.7}}>{card.description}</p>
                        )}
                    </CardContent>
                </Card>
            );
        }

        if (dragState.activeType === 'column') {
            const column = dragState.activeItem as ColumnItem;
            const columnCards = column.taskIds.map((taskId: string) => board.tasks[taskId]);
            return (
                <Column
                    column={column}
                    cards={columnCards}
                    onAddCard={handleAddCardClick}
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
        <MediaResolverProvider ownerId={ownerId} mountId={path.mountId} mediaFolderId={null} chatFolderId={chatFolderId}>
        <div className="flex flex-col h-full w-full">
            <Toolbar path={path} canWrite={canWrite} undoManager={undoManager}
                     onAccessDialogOpen={onAccessDialogOpen} onRestore={handleRestore}
                     onAddColumn={() => setIsAddColumnDialogOpen(true)}/>
            <div className="flex-1 w-full flex overflow-hidden">
                <div
                    className="overflow-x-auto overflow-y-hidden flex-1"
                    style={board.columnOrder.length > 1 ? {
                        padding: 0,
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
                            threshold: {x: 0.2, y: 0.2},
                            acceleration: 10,
                            interval: 10,
                            layoutShiftCompensation: false,
                        }}
                    >
                        <div className={`flex gap-0 h-full bg-muted`}>
                            <SortableContext items={board.columnOrder} strategy={horizontalListSortingStrategy}>
                                {board.columnOrder.map((columnId) => {
                                    const column = board.columns[columnId];
                                    const columnCards = column.taskIds.map((taskId) => board.tasks[taskId]);
                                    return (
                                        <Column
                                            key={column.id}
                                            column={column}
                                            cards={columnCards}
                                            onAddCard={handleAddCardClick}
                                            onEditColumn={handleEditColumn}
                                            isMobile={isMobile}
                                            yjsDoc={yjsDoc}
                                            ownerId={ownerId}
                                            mountId={path.mountId}
                                        />
                                    );
                                })}
                            </SortableContext>
                        </div>

                        <DragOverlay adjustScale={false}>
                            {getActiveComponent()}
                        </DragOverlay>
                    </DndContext>

                    <AddCardDialog
                        isOpen={isAddCardDialogOpen}
                        onClose={() => setIsAddCardDialogOpen(false)}
                        onAddCard={handleAddCard}
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
                            columnTitle={board.columns[editColumnId]?.title || ''}
                            yjsDoc={yjsDoc}
                        />
                    )}
                </div>
            </div>
        </div>
        </MediaResolverProvider>
    );
}
