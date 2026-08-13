import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { useAuth } from '@workspace/lib/auth';
import { useYjsUndoHotkeys } from '@workspace/lib/collab';
import {
    findCardIdByChatName,
    matchesCommentFilter,
    useCommentFilter,
    useCommentLifecycle,
} from '@workspace/lib/comments';
import { MediaResolverProvider, useRecordHistory } from '@workspace/lib/drive';
import { useIsMobile } from '@workspace/lib/media';
import { useDocCommentSearchHalf } from '@workspace/lib/search';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CardAttachmentDraft, CommentCard } from '@workspace/lib/types/comments';
import type { DocCommentSearch } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CardFormDialog, CommentLifecycleDialogs, LoadingState, NoteCard, PanelColumn } from '@workspace/ui';
import { useAttachmentMeta } from '@workspace/ui/components/attachment';
import type { CommentContextMenuItem } from '@workspace/ui/components/comments';
import { useContextMenu } from '@workspace/ui/components/context-menu';
import { DeleteDialog } from '@workspace/ui/components/delete/delete-dialog';
import { ColumnLayout, Column as LayoutColumn } from '@workspace/ui/components/layout/app/column-layout';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import { useCallback, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { AddColumnDialog } from './add-column-dialog';
import { Column } from './column';
import { ColumnSettingsDialog } from './column-settings-dialog';
import { useBoard } from './hooks/use-board';
import { useDragAndDrop } from './hooks/use-drag-and-drop';
import { useStickiesDocSearch } from './hooks/use-stickies-doc-search';
import { Toolbar } from './toolbar';
import type { ColumnItem } from './types';

// Rendered inside the DragOverlay (and therefore inside MediaResolverProvider) — the
// useAttachmentMeta context read only works below the provider StickiesBoard renders.
function OverlayNoteCard({ card, entry, isMobile }: { card: CommentCard; entry?: CommentEntry; isMobile: boolean }) {
    const { coverThumbnailUrl, attachmentCount } = useAttachmentMeta(card.attachments);
    return (
        <NoteCard
            title={card.title}
            description={card.description}
            color={card.color}
            replyCount={entry?.messageCount}
            resolved={entry?.status === 'resolved'}
            coverThumbnailUrl={coverThumbnailUrl}
            attachmentCount={attachmentCount}
            assigneeEmail={entry?.assignee}
            className={isMobile ? 'w-full' : 'w-[254px]'}
        />
    );
}

type StickiesBoardProps = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    chatFolderId: string | null;
    mediaFolderId: string | null;
    onAccessDialogOpen: () => void;
    initialChatName?: string;
    onClearInitialChat?: () => void;
    initialSearchTerm?: string;
    initialCardId?: string;
    onClearInitialCard?: () => void;
};

export function StickiesBoard({
    ownerId,
    path,
    canWrite,
    chatFolderId,
    mediaFolderId,
    onAccessDialogOpen,
    initialChatName,
    onClearInitialChat,
    initialSearchTerm,
    initialCardId,
    onClearInitialCard,
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
    const { user } = useAuth();

    // Cards are anchored by column membership — every referenced taskId is an active card.
    const activeCardIds = useMemo(() => {
        const ids = new Set<string>();
        for (const column of Object.values(board.columns)) {
            for (const id of column.taskIds) ids.add(id);
        }
        return ids;
    }, [board]);

    const lifecycle = useCommentLifecycle({
        ownerId,
        mountId: path.mountId,
        pathId: path.id,
        chatFolderId,
        mediaFolderId,
        doc: yjsDoc,
        activeCardIds,
        initialChatName,
        mapName: 'tasks',
        ready: isSynced,
        onChatNotFound: onClearInitialChat,
        initialCardId,
        onCardNotFound: onClearInitialCard,
    });
    const { allComments, cards, createCard, assignComment, members, setOpenCardId } = lifecycle;

    // Palette IN COMMENTS capability. Plain object per render — usePaletteDocSearch stabilises via
    // ref + docKey, so the reveal closure always sees the current cards.
    const commentSearchHalf = useDocCommentSearchHalf(ownerId, path.mountId, path.id);
    const commentSearch: DocCommentSearch = {
        ...commentSearchHalf,
        // chatName → cardId client-side; a stale or unknown chatName no-ops — never throws.
        reveal: (chatName) => {
            const cardId = findCardIdByChatName(cards, chatName);
            if (cardId) setOpenCardId(cardId);
        },
    };

    const recordHistory = useRecordHistory(ownerId, path.mountId, path.id);
    const { dragState, handleDragStart, handleDragEnd } = useDragAndDrop({
        board,
        cards,
        yjsDoc,
        onRecordEvent: recordHistory.mutate,
    });

    const entryByChatName = useMemo(() => {
        const map = new Map<string, CommentEntry>();
        for (const c of allComments) map.set(c.chatName, c);
        return map;
    }, [allComments]);

    useYjsUndoHotkeys(undoManager, canWrite);

    const isMobile = useIsMobile();
    const [editColumnId, setEditColumnId] = useState<string | null>(null);
    // Board shows resolved cards by default (status:'all'); clear() returns to that.
    const commentFilter = useCommentFilter({ status: 'all' });
    const currentUserEmail = user?.email ?? '';
    const isCardVisible = useCallback(
        (card: CommentCard) =>
            matchesCommentFilter(
                card,
                card.chatName ? entryByChatName.get(card.chatName) : undefined,
                commentFilter.filter,
                currentUserEmail,
            ),
        [entryByChatName, commentFilter.filter, currentUserEmail],
    );
    const [activityPanelOpen, setActivityPanelOpen] = useState(false);
    const cardContextMenu = useContextMenu<CommentContextMenuItem>();
    const [deleteCardId, setDeleteCardId] = useState<string | null>(null);

    const boardScrollRef = useRef<HTMLDivElement>(null);
    const {
        controller: docSearchController,
        highlightedCardIds,
        highlightedColumnIds,
    } = useStickiesDocSearch({
        board,
        cards,
        isCardVisible,
        boardScrollRef,
    });

    // Add-card dialog state
    const [addOpen, setAddOpen] = useState(false);
    const [addTargetColumn, setAddTargetColumn] = useState<string | null>(null);
    // Bumped after each successful add so the target column scrolls its newly-inserted top card into view.
    const [scrollToTopOf, setScrollToTopOf] = useState<{ columnId: string; n: number } | null>(null);

    const onSaveNew = useCallback(
        async (
            patch: { title?: string; description?: string; color?: string },
            attachments?: CardAttachmentDraft[],
            assignee?: string | null,
        ) => {
            if (!yjsDoc || !addTargetColumn) return;
            const targetColumnId = addTargetColumn;
            const card = await createCard({ ...patch, attachments }, (card) => {
                const col = yjsDoc.getMap('columns').get(targetColumnId) as Y.Map<unknown> | undefined;
                if (!col) return;
                let taskIds = col.get('taskIds') as Y.Array<string> | undefined;
                if (!taskIds) {
                    taskIds = new Y.Array<string>();
                    col.set('taskIds', taskIds);
                }
                taskIds.insert(0, [card.id]);
            });
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            recordHistory.mutate({
                eventType: 'sticky-added',
                details: {
                    card: patch.title ?? '',
                    toColumn: board.columns[targetColumnId]?.title ?? '',
                    cardId: card?.id ?? '',
                },
            });
            setScrollToTopOf((prev) => ({ columnId: targetColumnId, n: (prev?.n ?? 0) + 1 }));
            setAddTargetColumn(null);
            setAddOpen(false);
        },
        [yjsDoc, addTargetColumn, createCard, assignComment, recordHistory.mutate, board.columns],
    );

    const handleAddCard = useCallback((columnId: string) => {
        setAddTargetColumn(columnId);
        setAddOpen(true);
    }, []);

    const handleEditColumn = useCallback((columnId: string) => setEditColumnId(columnId), []);

    const { handleContextMenu, openAt: openCardContextMenuAt } = cardContextMenu;
    const handleCardContextMenu = useCallback(
        (e: React.MouseEvent, card: CommentCard) => {
            handleContextMenu(e, { card, entry: card.chatName ? entryByChatName.get(card.chatName) : undefined });
        },
        [handleContextMenu, entryByChatName],
    );
    // Long-press opens the same card menu on touch (`touch-none` cards get no native contextmenu).
    const handleCardLongPress = useCallback(
        (card: CommentCard, x: number, y: number) => {
            openCardContextMenuAt(
                { card, entry: card.chatName ? entryByChatName.get(card.chatName) : undefined },
                x,
                y,
            );
        },
        [openCardContextMenuAt, entryByChatName],
    );

    // Per-column card arrays with stable identity, so memoized columns only re-render
    // when their own cards (or the filter) actually change.
    const prevColumnCardsRef = useRef<Record<string, CommentCard[]>>({});
    const columnCards = useMemo(() => {
        const next: Record<string, CommentCard[]> = {};
        for (const columnId of board.columnOrder) {
            const fresh = board.columns[columnId].taskIds.map((taskId) => cards[taskId]).filter(isCardVisible);
            const prev = prevColumnCardsRef.current[columnId];
            next[columnId] =
                prev && prev.length === fresh.length && fresh.every((card, i) => card === prev[i]) ? prev : fresh;
        }
        prevColumnCardsRef.current = next;
        return next;
    }, [board, cards, isCardVisible]);

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 5 },
        }),
    );

    const getActiveComponent = () => {
        if (!dragState.activeId || !dragState.activeType || !dragState.activeItem) return null;

        if (dragState.activeType === 'task') {
            const card = dragState.activeItem as CommentCard;
            const entry = card.chatName ? entryByChatName.get(card.chatName) : undefined;
            return <OverlayNoteCard card={card} entry={entry} isMobile={isMobile} />;
        }

        if (dragState.activeType === 'column') {
            const column = dragState.activeItem as ColumnItem;
            return (
                <Column
                    column={column}
                    cards={column.taskIds.map((taskId) => cards[taskId])}
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

    if (!isSynced) return <LoadingState />;

    return (
        <MediaResolverProvider
            ownerId={ownerId}
            mountId={path.mountId}
            mediaFolderId={mediaFolderId}
            chatFolderId={chatFolderId}
        >
            <ColumnLayout>
                <div className="flex-1 min-w-0 h-full">
                    <DocSearchProvider
                        controller={docSearchController}
                        commentSearch={commentSearch}
                        initialSearchTerm={initialSearchTerm}
                        barClassName="top-14"
                    >
                        <LayoutColumn
                            id="board"
                            width="flex"
                            toolbarBorder="always"
                            toolbar={
                                <Toolbar
                                    path={path}
                                    canWrite={canWrite}
                                    undoManager={undoManager}
                                    onAccessDialogOpen={onAccessDialogOpen}
                                    onAddColumn={() => setIsAddColumnDialogOpen(true)}
                                    filter={commentFilter}
                                    members={members}
                                    currentUserEmail={currentUserEmail}
                                    // Only offer the toggle where the panel can render (!isMobile),
                                    // else it's an enabled no-op. DocumentShareCluster hides it when absent.
                                    onToggleActivityPanel={
                                        !isMobile ? () => setActivityPanelOpen((v) => !v) : undefined
                                    }
                                    activityPanelOpen={activityPanelOpen}
                                />
                            }
                        >
                            <div className="h-full w-full flex overflow-hidden">
                                <div
                                    ref={boardScrollRef}
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
                                            <SortableContext
                                                items={board.columnOrder}
                                                strategy={horizontalListSortingStrategy}
                                            >
                                                {board.columnOrder.map((columnId) => {
                                                    const column = board.columns[columnId];
                                                    return (
                                                        <Column
                                                            key={column.id}
                                                            column={column}
                                                            cards={columnCards[columnId]}
                                                            entryByChatName={entryByChatName}
                                                            canWrite={canWrite}
                                                            onAddCard={handleAddCard}
                                                            onEditColumn={handleEditColumn}
                                                            onCardOpen={setOpenCardId}
                                                            onCardContextMenu={
                                                                canWrite ? handleCardContextMenu : undefined
                                                            }
                                                            onCardLongPress={canWrite ? handleCardLongPress : undefined}
                                                            highlighted={highlightedColumnIds.has(column.id)}
                                                            highlightedCardIds={highlightedCardIds}
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
                                        allowAttachments={!!mediaFolderId}
                                        members={members}
                                        currentUserEmail={user?.email}
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
                                            isOpen={!!editColumnId}
                                            onClose={() => setEditColumnId(null)}
                                            columnId={editColumnId}
                                            columnTitle={board.columns[editColumnId]?.title || ''}
                                            cardCount={board.columns[editColumnId]?.taskIds.length || 0}
                                            yjsDoc={yjsDoc}
                                        />
                                    )}

                                    <DeleteDialog
                                        open={!!deleteCardId}
                                        onOpenChange={(open) => !open && setDeleteCardId(null)}
                                        title="Delete Card"
                                        description="This will permanently delete the card. This action cannot be undone."
                                        onDelete={() => {
                                            if (deleteCardId) {
                                                const removed = cards[deleteCardId];
                                                deleteCardFromBoard(deleteCardId);
                                                recordHistory.mutate({
                                                    eventType: 'sticky-removed',
                                                    details: { card: removed?.title ?? '', cardId: deleteCardId },
                                                });
                                            }
                                        }}
                                    />

                                    <CommentLifecycleDialogs
                                        lifecycle={lifecycle}
                                        path={path}
                                        canWrite={canWrite}
                                        commentContextMenu={cardContextMenu}
                                        onDelete={setDeleteCardId}
                                        noun="sticky"
                                        onCardDialogClose={onClearInitialChat}
                                    />
                                </div>
                                {!isMobile && activityPanelOpen && (
                                    <PanelColumn
                                        activePanel="activity"
                                        onClose={() => setActivityPanelOpen(false)}
                                        path={path}
                                        cards={cards}
                                        entries={allComments}
                                        members={members}
                                        currentUserEmail={currentUserEmail}
                                        filter={commentFilter}
                                        commentContextMenu={cardContextMenu}
                                        onOpenCard={setOpenCardId}
                                    />
                                )}
                            </div>
                        </LayoutColumn>
                    </DocSearchProvider>
                </div>
            </ColumnLayout>
        </MediaResolverProvider>
    );
}
