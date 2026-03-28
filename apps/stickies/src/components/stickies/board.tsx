import {DndContext, DragOverlay, PointerSensor, useSensor, useSensors} from '@dnd-kit/core';
import {horizontalListSortingStrategy, SortableContext} from '@dnd-kit/sortable';
import {useHotkey} from '@tanstack/react-hotkeys';
import {EIGEN_STICKIES_COLORS, lightenColor} from '@workspace/lib/constants';
import {MediaResolverProvider} from '@workspace/lib/drive';
import {useIsMobile} from '@workspace/lib/media';
import type {DrivePath} from '@workspace/lib/types/drive';
import {Card, CardContent} from '@workspace/ui/components/card';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {ContextMenuAnchor, useContextMenu} from '@workspace/ui/components/layout/context-menu';
import {DeleteDialog} from '@workspace/ui/components/layout/delete/delete-dialog';
import {isLightColor} from '@workspace/ui/components/layout/media/color-picker';
import {Check, CircleOff, Palette, Pencil, Trash2} from 'lucide-react';
import {useCallback, useState} from 'react';
import * as Y from 'yjs';
import {AddCardDialog} from './add-card-dialog';
import {AddColumnDialog} from './add-column-dialog';
import {CardSettingsDialog} from './card-settings-dialog';
import {Column} from './column';
import {ColumnSettingsDialog} from './column-settings-dialog';
import {useBoard} from './hooks/use-board';
import {useDragAndDrop} from './hooks/use-drag-and-drop';
import {Toolbar} from './toolbar';
import type {CardItem, ColumnItem} from './types';

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
};

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

    const {dragState, handleDragStart, handleDragEnd} = useDragAndDrop({board, yjsDoc});

    useHotkey(
        'Mod+Z',
        (e) => {
            e.preventDefault();
            undoManager?.undo();
        },
        {enabled: canWrite && !!undoManager},
    );

    useHotkey(
        'Mod+Y',
        (e) => {
            e.preventDefault();
            undoManager?.redo();
        },
        {enabled: canWrite && !!undoManager},
    );

    useHotkey(
        'Mod+Shift+Z',
        (e) => {
            e.preventDefault();
            undoManager?.redo();
        },
        {enabled: canWrite && !!undoManager},
    );

    const isMobile = useIsMobile();
    const [editColumnId, setEditColumnId] = useState<string | null>(null);
    const [isColumnSettingsOpen, setIsColumnSettingsOpen] = useState(false);
    const [colorFilter, setColorFilter] = useState<Set<string>>(new Set());
    const cardContextMenu = useContextMenu<CardItem>();
    const [editCardId, setEditCardId] = useState<string | null>(null);
    const [deleteCardId, setDeleteCardId] = useState<string | null>(null);

    const handleCardContextEdit = () => {
        if (cardContextMenu.item) setEditCardId(cardContextMenu.item.id);
        cardContextMenu.close();
    };

    const handleCardContextDelete = () => {
        if (cardContextMenu.item) setDeleteCardId(cardContextMenu.item.id);
        cardContextMenu.close();
    };

    const handleCardContextColor = (color: string) => {
        if (!yjsDoc || !cardContextMenu.item) return;
        yjsDoc.transact(() => {
            const taskMap = yjsDoc.getMap('tasks').get(cardContextMenu.item!.id) as Y.Map<unknown>;
            if (taskMap) taskMap.set('color', color);
        });
        cardContextMenu.close();
    };

    const handleDeleteCard = () => {
        if (!yjsDoc || !deleteCardId) return;
        yjsDoc.transact(() => {
            const columnsMap = yjsDoc.getMap('columns');
            for (const [, col] of columnsMap) {
                if (!(col instanceof Y.Map)) continue;
                const taskIds = col.get('taskIds') as Y.Array<string>;
                const index = (taskIds.toArray() as string[]).indexOf(deleteCardId);
                if (index !== -1) {
                    taskIds.delete(index, 1);
                    break;
                }
            }
            yjsDoc.getMap('tasks').delete(deleteCardId);
        });
        setDeleteCardId(null);
    };

    const handleEditColumn = (columnId: string) => {
        setEditColumnId(columnId);
        setIsColumnSettingsOpen(true);
    };

    const handleRestore = useCallback(
        (state: Uint8Array) => {
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
        },
        [yjsDoc],
    );

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {distance: 5},
        }),
    );

    const getActiveComponent = () => {
        if (!dragState.activeId || !dragState.activeType || !dragState.activeItem) return null;

        if (dragState.activeType === 'task') {
            const card = dragState.activeItem as CardItem;
            return (
                <Card
                    className={`${isMobile ? 'w-full p-0' : 'w-[254px] p-0'} shadow-md rounded-none ${!card.color ? 'border' : 'border-0'}`}
                    style={{
                        backgroundColor: card.color ? lightenColor(card.color, 0.25) : undefined,
                        color: card.color ? (isLightColor(card.color) ? '#000' : '#fff') : undefined,
                    }}
                >
                    <CardContent className={`p-3 text-sm ${!card.color ? 'bg-accent' : ''}`}>
                        {card.title}
                        {card.description && (
                            <p className="text-xs mt-1 line-clamp-2" style={{opacity: 0.7}}>
                                {card.description}
                            </p>
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
                    canWrite={canWrite}
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
        <MediaResolverProvider
            ownerId={ownerId}
            mountId={path.mountId}
            mediaFolderId={null}
            chatFolderId={chatFolderId}
        >
            <div className="flex flex-col h-full w-full">
                <Toolbar
                    path={path}
                    canWrite={canWrite}
                    undoManager={undoManager}
                    onAccessDialogOpen={onAccessDialogOpen}
                    onRestore={handleRestore}
                    onAddColumn={() => setIsAddColumnDialogOpen(true)}
                    colorFilter={colorFilter}
                    onColorFilterChange={setColorFilter}
                />
                <div className="flex-1 w-full flex overflow-hidden">
                    <div
                        className="overflow-x-auto overflow-y-hidden flex-1"
                        style={
                            board.columnOrder.length > 0
                                ? {
                                    padding: 0,
                                    scrollSnapType: 'x mandatory',
                                    scrollBehavior: 'smooth',
                                }
                                : {
                                    visibility: 'hidden',
                                }
                        }
                    >
                        <DndContext
                            sensors={canWrite ? sensors : []}
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
                                        const columnCards = column.taskIds
                                            .map((taskId) => board.tasks[taskId])
                                            .filter(
                                                (card) => colorFilter.size === 0 || colorFilter.has(card.color || ''),
                                            );
                                        return (
                                            <Column
                                                key={column.id}
                                                column={column}
                                                cards={columnCards}
                                                canWrite={canWrite}
                                                onAddCard={handleAddCardClick}
                                                onEditColumn={handleEditColumn}
                                                onCardContextMenu={
                                                    canWrite ? cardContextMenu.handleContextMenu : undefined
                                                }
                                                isMobile={isMobile}
                                                yjsDoc={yjsDoc}
                                                ownerId={ownerId}
                                                mountId={path.mountId}
                                            />
                                        );
                                    })}
                                </SortableContext>
                            </div>

                            <DragOverlay adjustScale={false}>{getActiveComponent()}</DragOverlay>
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
                                key={editColumnId}
                                isOpen={isColumnSettingsOpen}
                                onClose={() => setIsColumnSettingsOpen(false)}
                                columnId={editColumnId}
                                columnTitle={board.columns[editColumnId]?.title || ''}
                                cardCount={board.columns[editColumnId]?.taskIds.length || 0}
                                canWrite={canWrite}
                                yjsDoc={yjsDoc}
                            />
                        )}

                        <ContextMenuAnchor contextMenu={cardContextMenu}>
                            <DropdownMenuItem onClick={handleCardContextEdit}>
                                <Pencil className="h-4 w-4 mr-2"/> Edit
                            </DropdownMenuItem>
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <Palette className="h-4 w-4 mr-2"/> Color
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <div className="flex gap-1 p-2">
                                        <button
                                            className="h-4 w-4 rounded-full border border-border hover:scale-125 transition-transform flex items-center justify-center bg-background"
                                            title="No color"
                                            onClick={() => handleCardContextColor('')}
                                        >
                                            <CircleOff className="h-2.5 w-2.5 text-muted-foreground"/>
                                        </button>
                                        {EIGEN_STICKIES_COLORS[0].map((c) => (
                                            <button
                                                key={c.value}
                                                className="h-4 w-4 rounded-full border border-border/50 hover:scale-125 transition-transform flex items-center justify-center"
                                                style={{backgroundColor: c.value}}
                                                title={c.label}
                                                onClick={() => handleCardContextColor(c.value)}
                                            >
                                                {cardContextMenu.item?.color === c.value && (
                                                    <Check
                                                        className="h-2 w-2"
                                                        style={{color: isLightColor(c.value) ? '#000' : '#fff'}}
                                                    />
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            <DropdownMenuSeparator/>
                            <DropdownMenuItem variant="destructive" onClick={handleCardContextDelete}>
                                <Trash2 className="h-4 w-4 mr-2"/> Delete
                            </DropdownMenuItem>
                        </ContextMenuAnchor>

                        {editCardId && board.tasks[editCardId] && (
                            <CardSettingsDialog
                                key={editCardId}
                                isOpen={!!editCardId}
                                onClose={() => setEditCardId(null)}
                                cardId={editCardId}
                                cardTitle={board.tasks[editCardId].title}
                                cardDescription={board.tasks[editCardId].description}
                                cardColor={board.tasks[editCardId].color || ''}
                                yjsDoc={yjsDoc}
                            />
                        )}

                        <DeleteDialog
                            open={!!deleteCardId}
                            onOpenChange={(open) => !open && setDeleteCardId(null)}
                            title="Delete Card"
                            description="This will permanently delete the card. This action cannot be undone."
                            onDelete={handleDeleteCard}
                        />
                    </div>
                </div>
            </div>
        </MediaResolverProvider>
    );
}
