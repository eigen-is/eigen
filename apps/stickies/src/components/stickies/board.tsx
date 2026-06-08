import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { useHotkey } from '@tanstack/react-hotkeys';
import { getDriveItemUrl } from '@workspace/lib/api';
import { useComments, useResolveComment } from '@workspace/lib/chat';
import {
    useCardIdFromChatName,
    useCreateCommentCard,
    useOpenCommentCard,
    useUpdateCommentCard,
} from '@workspace/lib/comments';
import { MediaResolverProvider } from '@workspace/lib/drive';
import { useIsMobile } from '@workspace/lib/media';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CardDialog, CardFormDialog, CommentMenuItems, LoadingState, NoteCard } from '@workspace/ui';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ColumnLayout, Column as LayoutColumn } from '@workspace/ui/components/layout/app/column-layout';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { useCallback, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { AddColumnDialog } from './add-column-dialog';
import { Column } from './column';
import { ColumnSettingsDialog } from './column-settings-dialog';
import { useBoard } from './hooks/use-board';
import { useDragAndDrop } from './hooks/use-drag-and-drop';
import { Toolbar } from './toolbar';
import type { ColumnItem } from './types';

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

    const { data: commentList = [] } = useComments(ownerId, path.mountId, path.id);
    const entryByChatName = useMemo(() => {
        const map = new Map<string, CommentEntry>();
        for (const c of commentList) map.set(c.chatName, c);
        return map;
    }, [commentList]);
    const entryFor = (card: CommentCard) => (card.chatName ? entryByChatName.get(card.chatName) : undefined);

    // Shared comment-card hooks for the new dialog path
    const createCard = useCreateCommentCard(ownerId, path.mountId, chatFolderId, yjsDoc ?? null, 'tasks');
    const updateCard = useUpdateCommentCard(yjsDoc ?? null, 'tasks');
    const resolveComment = useResolveComment(ownerId, path.mountId, path.id);

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
    const cardContextMenu = useContextMenu<CommentCard>();
    const [deleteCardId, setDeleteCardId] = useState<string | null>(null);
    const [openCardId, setOpenCardId] = useState<string | null>(null);

    // Add-card dialog state
    const [addOpen, setAddOpen] = useState(false);
    const [addTargetColumn, setAddTargetColumn] = useState<string | null>(null);
    // Bumped after each successful add so the target column scrolls its newly-inserted top card into view.
    const [scrollToTopOf, setScrollToTopOf] = useState<{ columnId: string; n: number } | null>(null);

    useCardIdFromChatName(board.tasks, initialChatName, setOpenCardId, {
        ready: isSynced,
        onChatNotFound: onClearInitialChat,
    });

    const { card: openCard, entry: openEntry } = useOpenCommentCard(board.tasks, commentList, openCardId);

    const handleAddCard = (columnId: string) => {
        setAddTargetColumn(columnId);
        setAddOpen(true);
    };

    const onSaveNew = useCallback(
        async (patch: { title?: string; description?: string; color?: string }) => {
            if (!yjsDoc || !addTargetColumn) return;
            const targetColumnId = addTargetColumn;
            await createCard(patch, (card) => {
                const col = yjsDoc.getMap('columns').get(targetColumnId) as Y.Map<unknown> | undefined;
                if (!col) return;
                let taskIds = col.get('taskIds') as Y.Array<string> | undefined;
                if (!taskIds) {
                    taskIds = new Y.Array<string>();
                    col.set('taskIds', taskIds);
                }
                taskIds.insert(0, [card.id]);
            });
            setScrollToTopOf((prev) => ({ columnId: targetColumnId, n: (prev?.n ?? 0) + 1 }));
            setAddTargetColumn(null);
            setAddOpen(false);
        },
        [yjsDoc, addTargetColumn, createCard],
    );

    const handleCardOpen = useCallback((cardId: string) => {
        setOpenCardId(cardId);
    }, []);

    const handleCardClose = useCallback(() => {
        setOpenCardId(null);
        onClearInitialChat?.();
    }, [onClearInitialChat]);

    const handleCardContextOpen = (cardId: string) => {
        setOpenCardId(cardId);
        cardContextMenu.close();
    };

    const handleCardContextDelete = (cardId: string) => {
        setDeleteCardId(cardId);
        cardContextMenu.close();
    };

    const handleCardContextColor = (cardId: string, color: string) => {
        updateCard(cardId, { color });
        cardContextMenu.close();
    };

    const handleCardContextResolve = (chatName: string, status: 'open' | 'resolved') => {
        resolveComment.mutate({ chatName, status });
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

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 5 },
        }),
    );

    const getActiveComponent = () => {
        if (!dragState.activeId || !dragState.activeType || !dragState.activeItem) return null;

        if (dragState.activeType === 'task') {
            const card = dragState.activeItem as CommentCard;
            const entry = entryFor(card);
            return (
                <NoteCard
                    title={card.title}
                    description={card.description}
                    color={card.color}
                    replyCount={entry?.messageCount}
                    resolved={entry?.status === 'resolved'}
                    className={isMobile ? 'w-full' : 'w-[254px]'}
                />
            );
        }

        if (dragState.activeType === 'column') {
            const column = dragState.activeItem as ColumnItem;
            const columnCards = column.taskIds.map((taskId: string) => board.tasks[taskId]);
            return (
                <Column
                    column={column}
                    cards={columnCards}
                    entryByChatName={entryByChatName}
                    canWrite={canWrite}
                    onAddCard={handleAddCard}
                    onEditColumn={handleEditColumn}
                    isMobile={isMobile}
                />
            );
        }

        return null;
    };

    const contextMenuItem = cardContextMenu.item
        ? { card: cardContextMenu.item, entry: entryFor(cardContextMenu.item) }
        : null;

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
                                                .map((taskId) => board.tasks[taskId])
                                                .filter(
                                                    (card) =>
                                                        colorFilter.size === 0 || colorFilter.has(card.color || ''),
                                                );
                                            return (
                                                <Column
                                                    key={column.id}
                                                    column={column}
                                                    cards={columnCards}
                                                    entryByChatName={entryByChatName}
                                                    canWrite={canWrite}
                                                    onAddCard={handleAddCard}
                                                    onEditColumn={handleEditColumn}
                                                    onCardOpen={handleCardOpen}
                                                    onCardContextMenu={
                                                        canWrite ? cardContextMenu.handleContextMenu : undefined
                                                    }
                                                    isMobile={isMobile}
                                                    scrollToTopSignal={
                                                        scrollToTopOf?.columnId === column.id
                                                            ? scrollToTopOf.n
                                                            : undefined
                                                    }
                                                />
                                            );
                                        })}
                                    </SortableContext>
                                </div>

                                <DragOverlay adjustScale={false}>{getActiveComponent()}</DragOverlay>
                            </DndContext>

                            <CardFormDialog
                                open={addOpen}
                                onOpenChange={(o) => {
                                    setAddOpen(o);
                                    if (!o) setAddTargetColumn(null);
                                }}
                                onSave={onSaveNew}
                                dialogTitle="Add Sticky"
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
                                <CommentMenuItems
                                    primitives={{
                                        Item: DropdownMenuItem,
                                        Sub: DropdownMenuSub,
                                        SubTrigger: DropdownMenuSubTrigger,
                                        SubContent: DropdownMenuSubContent,
                                    }}
                                    noun="sticky"
                                    item={contextMenuItem}
                                    onOpen={handleCardContextOpen}
                                    onChangeColor={handleCardContextColor}
                                    onResolve={(chatName) => handleCardContextResolve(chatName, 'resolved')}
                                    onReopen={(chatName) => handleCardContextResolve(chatName, 'open')}
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
                                onUpdate={(patch) => openCard && updateCard(openCard.id, patch)}
                                onResolve={(chatName, next) => resolveComment.mutate({ chatName, status: next })}
                            />
                        </div>
                    </div>
                </LayoutColumn>
            </ColumnLayout>
        </MediaResolverProvider>
    );
}
