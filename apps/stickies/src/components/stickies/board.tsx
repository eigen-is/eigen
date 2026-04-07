import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { useHotkey } from '@tanstack/react-hotkeys';
import { useComments } from '@workspace/lib/chat';
import { restoreYjsDoc } from '@workspace/lib/collab';
import { MediaResolverProvider } from '@workspace/lib/drive';
import { useIsMobile } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { LoadingState, NoteCard, NoteCardContextMenu } from '@workspace/ui';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { useCallback, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { AddCardDialog } from './add-card-dialog';
import { AddColumnDialog } from './add-column-dialog';
import { CardSettingsDialog } from './card-settings-dialog';
import { Column } from './column';
import { ColumnSettingsDialog } from './column-settings-dialog';
import { useBoard } from './hooks/use-board';
import { useDragAndDrop } from './hooks/use-drag-and-drop';
import { Toolbar } from './toolbar';
import type { CardItem, ColumnItem } from './types';

type StickiesBoardProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    chatFolderId: string | null;
    onAccessDialogOpen: () => void;
};

export function StickiesBoard({ ownerId, path, canWrite, chatFolderId, onAccessDialogOpen }: StickiesBoardProps) {
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
        isSynced,
        yjsDoc,
        undoManager,
    } = useBoard(ownerId, path.mountId, path.id, chatFolderId);

    const { dragState, handleDragStart, handleDragEnd } = useDragAndDrop({ board, yjsDoc });

    // Enrich cards with message counts from comments.db
    const { data: commentList = [] } = useComments(ownerId, path.mountId, path.id);
    const messageCounts = useMemo(() => {
        const map = new Map<string, number>();
        for (const c of commentList) {
            if (c.messageCount > 0) map.set(c.chatName, c.messageCount);
        }
        return map;
    }, [commentList]);

    const enrichCard = useCallback(
        (card: CardItem): CardItem => {
            if (!card.chatName) return card;
            const count = messageCounts.get(card.chatName);
            return count ? { ...card, messageCount: count } : card;
        },
        [messageCounts],
    );

    useHotkey(
        'Mod+Z',
        (e) => {
            e.preventDefault();
            undoManager?.undo();
        },
        { enabled: canWrite && !!undoManager },
    );

    useHotkey(
        'Mod+Y',
        (e) => {
            e.preventDefault();
            undoManager?.redo();
        },
        { enabled: canWrite && !!undoManager },
    );

    useHotkey(
        'Mod+Shift+Z',
        (e) => {
            e.preventDefault();
            undoManager?.redo();
        },
        { enabled: canWrite && !!undoManager },
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
            restoreYjsDoc(yjsDoc, state);
        },
        [yjsDoc],
    );

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 5 },
        }),
    );

    const getActiveComponent = () => {
        if (!dragState.activeId || !dragState.activeType || !dragState.activeItem) return null;

        if (dragState.activeType === 'task') {
            const card = dragState.activeItem as CardItem;
            return (
                <NoteCard
                    title={card.title}
                    description={card.description}
                    color={card.color}
                    className={isMobile ? 'w-full' : 'w-[254px]'}
                />
            );
        }

        if (dragState.activeType === 'column') {
            const column = dragState.activeItem as ColumnItem;
            const columnCards = column.taskIds.map((taskId: string) => enrichCard(board.tasks[taskId]));
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

    if (!isSynced) return <LoadingState />;

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
                                threshold: { x: 0.2, y: 0.2 },
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
                                            .map((taskId) => enrichCard(board.tasks[taskId]))
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
                            <NoteCardContextMenu
                                currentColor={cardContextMenu.item?.color}
                                onEdit={handleCardContextEdit}
                                onChangeColor={handleCardContextColor}
                                onDelete={handleCardContextDelete}
                            />
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
