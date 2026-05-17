import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { useHotkey } from '@tanstack/react-hotkeys';
import { getDriveItemUrl } from '@workspace/lib/api';
import { useComments } from '@workspace/lib/chat';
import { restoreYjsDoc } from '@workspace/lib/collab';
import { useCommentCards, useCreateCommentCard, useUpdateCommentCard } from '@workspace/lib/comments';
import { MediaResolverProvider } from '@workspace/lib/drive';
import { useIsMobile } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { AddCardDialog, CardDialog, LoadingState, NoteCard, NoteCardContextMenu } from '@workspace/ui';
import { ColumnLayout, Column as LayoutColumn } from '@workspace/ui/components/layout/app/column-layout';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { AddColumnDialog } from './add-column-dialog';
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
    initialChatName?: string;
    onClearInitialChat?: () => void;
};

export function StickiesBoard({
    ownerId,
    path,
    canWrite,
    chatFolderId,
    onAccessDialogOpen,
    initialChatName,
    onClearInitialChat,
}: StickiesBoardProps) {
    const {
        board,
        isAddColumnDialogOpen,
        setIsAddColumnDialogOpen,
        handleAddColumn,
        deleteCardFromBoard,
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

    // Shared comment-card hooks for the new dialog path
    const cards = useCommentCards(yjsDoc ?? null, 'tasks');
    const createCard = useCreateCommentCard(ownerId, path.mountId, chatFolderId, yjsDoc ?? null, 'tasks');
    const updateCard = useUpdateCommentCard(yjsDoc ?? null, 'tasks');

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
    const [deleteCardId, setDeleteCardId] = useState<string | null>(null);
    const [openCardId, setOpenCardId] = useState<string | null>(null);

    // Add-card dialog state
    const [addOpen, setAddOpen] = useState(false);
    const [addTargetColumn, setAddTargetColumn] = useState<string | null>(null);

    // Track the chatName we've already auto-opened for so a YJS update arriving before the URL
    // clear navigates can't re-apply the auto-open after the user has closed the dialog.
    const autoOpenedForRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!initialChatName) {
            autoOpenedForRef.current = undefined;
            return;
        }
        if (!isSynced) return;
        if (autoOpenedForRef.current === initialChatName) return;
        autoOpenedForRef.current = initialChatName;
        const card = Object.values(board.tasks).find((t) => t.chatName === initialChatName);
        if (card) {
            setOpenCardId(card.id);
        } else {
            onClearInitialChat?.();
        }
    }, [initialChatName, board.tasks, isSynced, onClearInitialChat]);

    const openCard = openCardId ? (cards[openCardId] ?? null) : null;
    const openEntry = openCard?.chatName ? commentList.find((c) => c.chatName === openCard.chatName) : undefined;

    const handleAddCard = (columnId: string) => {
        setAddTargetColumn(columnId);
        setAddOpen(true);
    };

    const onSaveNew = async ({ title, description, color }: { title: string; description: string; color?: string }) => {
        const card = await createCard({ title, description, color });
        if (!card || !addTargetColumn) return;
        yjsDoc?.transact(() => {
            const columnsMap = yjsDoc.getMap('columns');
            const col = columnsMap.get(addTargetColumn) as Y.Map<unknown> | undefined;
            if (!col) return;
            let taskIds = col.get('taskIds') as Y.Array<string> | undefined;
            if (!taskIds) {
                taskIds = new Y.Array<string>();
                col.set('taskIds', taskIds);
            }
            taskIds.push([card.id]);
        });
    };

    const handleCardOpen = useCallback((cardId: string) => {
        setOpenCardId(cardId);
    }, []);

    const handleCardClose = useCallback(() => {
        setOpenCardId(null);
        onClearInitialChat?.();
    }, [onClearInitialChat]);

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
        if (!deleteCardId) return;
        deleteCardFromBoard(deleteCardId);
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
                    onAddCard={handleAddCard}
                    onEditColumn={handleEditColumn}
                    isMobile={isMobile}
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
            <ColumnLayout>
                <LayoutColumn
                    id="board"
                    width="flex"
                    toolbar={
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
                    }
                >
                    <div className="h-full w-full flex overflow-hidden">
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
                                                    (card) =>
                                                        colorFilter.size === 0 || colorFilter.has(card.color || ''),
                                                );
                                            return (
                                                <Column
                                                    key={column.id}
                                                    column={column}
                                                    cards={columnCards}
                                                    canWrite={canWrite}
                                                    onAddCard={handleAddCard}
                                                    onEditColumn={handleEditColumn}
                                                    onCardOpen={handleCardOpen}
                                                    onCardContextMenu={
                                                        canWrite ? cardContextMenu.handleContextMenu : undefined
                                                    }
                                                    isMobile={isMobile}
                                                />
                                            );
                                        })}
                                    </SortableContext>
                                </div>

                                <DragOverlay adjustScale={false}>{getActiveComponent()}</DragOverlay>
                            </DndContext>

                            <AddCardDialog
                                open={addOpen}
                                onOpenChange={(o) => {
                                    setAddOpen(o);
                                    if (!o) setAddTargetColumn(null);
                                }}
                                onSave={onSaveNew}
                                titleLabel="Add Sticky"
                                submitLabel="Add Sticky"
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
                                    onEdit={() => {
                                        if (cardContextMenu.item) setOpenCardId(cardContextMenu.item.id);
                                        cardContextMenu.close();
                                    }}
                                    onChangeColor={handleCardContextColor}
                                    onDelete={handleCardContextDelete}
                                />
                            </ContextMenuAnchor>

                            <DeleteDialog
                                open={!!deleteCardId}
                                onOpenChange={(open) => !open && setDeleteCardId(null)}
                                title="Delete Card"
                                description="This will permanently delete the card. This action cannot be undone."
                                onDelete={handleDeleteCard}
                            />

                            <CardDialog
                                open={!!openCard}
                                onOpenChange={(o) => {
                                    if (!o) handleCardClose();
                                }}
                                card={openCard}
                                entry={openEntry}
                                ownerId={ownerId}
                                mountId={path.mountId}
                                canWrite={canWrite}
                                copyLinkUrl={
                                    openCard?.chatName
                                        ? `${getDriveItemUrl(path)}?chat=${encodeURIComponent(openCard.chatName)}`
                                        : undefined
                                }
                                showResolveAction={false}
                                onUpdate={(patch) => openCard && updateCard(openCard.id, patch)}
                            />
                        </div>
                    </div>
                </LayoutColumn>
            </ColumnLayout>
        </MediaResolverProvider>
    );
}
