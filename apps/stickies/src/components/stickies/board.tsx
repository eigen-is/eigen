// A Stickies board: its columns of cards, dragging cards and columns into a new order, and the dialogs that add,
// edit and delete cards and columns. The board route shows it for one board file.

import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { useAuth } from '@workspace/lib/auth';
import { useUnreadCommentChatNames } from '@workspace/lib/chat';
import { boardCardIds, getIdArray, getItemMapRoot, useYjsUndoHotkeys } from '@workspace/lib/collab';
import { matchesCommentFilter, useCommentFilter, useCommentLifecycle } from '@workspace/lib/comments';
import { useRecordHistory } from '@workspace/lib/drive';
import { useDocCommentSearchHalf } from '@workspace/lib/search';
import type { CardAttachmentDraft, CardFormPatch, CommentCard } from '@workspace/lib/types/comments';
import { commentMapName } from '@workspace/lib/types/comments';
import type { DocCommentSearch } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_TYPE_STICKIES } from '@workspace/lib/types/drive';
import { CollabDocumentGate, ColumnLayout, Column as LayoutColumn, UnsyncedEditsGuard, useLayout } from '@workspace/ui';
import { CardFormDialog } from '@workspace/ui/components/cards';
import type { CommentContextMenuItem } from '@workspace/ui/components/comments';
import { CommentLifecycleDialogs, CommentNoteCard, PanelColumn } from '@workspace/ui/components/comments';
import { useContextMenu } from '@workspace/ui/components/context-menu';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import { useDialogOpen } from '@workspace/ui/hooks/use-dialog-open';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AddColumnDialog } from './add-column-dialog';
import { Column } from './column';
import { ColumnSettingsDialog } from './column-settings-dialog';
import { useBoard } from './hooks/use-board';
import { useDragAndDrop } from './hooks/use-drag-and-drop';
import { useStickiesDocSearch } from './hooks/use-stickies-doc-search';
import { useCardPresence, useStickiesPresence } from './hooks/use-stickies-presence';
import { Toolbar } from './toolbar';

const NO_CARDS: ReadonlySet<string> = new Set();

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
        offline,
        loaded,
        storageUnavailable,
        storageGone,
        unsyncedEdits,
        yjsDoc,
        undoManager,
        provider,
    } = useBoard(ownerId, path.mountId, path.id, chatFolderId, canWrite);
    const { user } = useAuth();

    // A card is in use while a column lists it, the rule the server's sweep reads too. The board's columns change
    // whenever a column or the card map does, so they say when to read the doc again.
    const activeCardIds = useMemo(() => (yjsDoc ? boardCardIds(yjsDoc) : NO_CARDS), [yjsDoc, board.columns]);

    const lifecycle = useCommentLifecycle({
        ownerId,
        mountId: path.mountId,
        pathId: path.id,
        chatFolderId,
        mediaFolderId,
        doc: yjsDoc,
        activeCardIds,
        initialChatName,
        mapName: commentMapName(DRIVE_TYPE_STICKIES),
        ready: isSynced,
        onChatNotFound: onClearInitialChat,
        initialCardId,
        onCardNotFound: onClearInitialCard,
    });
    const { allComments, cards, createCard, assignComment, members, setOpenCardId, openChat, openCard } = lifecycle;

    // The command palette's search in comments. It is a new object each render, and usePaletteDocSearch keeps it
    // stable itself, so the reveal closure always sees the current cards.
    const commentSearchHalf = useDocCommentSearchHalf(ownerId, path.mountId, path.id);
    const commentSearch: DocCommentSearch = {
        ...commentSearchHalf,
        // A hit whose card was deleted from the board opens as deleted, and an unknown chat name opens nothing.
        reveal: openChat,
    };

    const recordHistory = useRecordHistory(ownerId, path.mountId, path.id);
    const { dragState, handleDragStart, handleDragEnd } = useDragAndDrop({
        board,
        cards,
        yjsDoc,
        undoManager,
        createCard,
        onRecordEvent: recordHistory.mutate,
    });

    const entryByChatName = useMemo(() => new Map(allComments.map((entry) => [entry.chatName, entry])), [allComments]);
    const entryOf = useCallback(
        (card: CommentCard) => (card.chatName ? entryByChatName.get(card.chatName) : undefined),
        [entryByChatName],
    );
    const unreadChatNames = useUnreadCommentChatNames(user?.id ?? '', path.id);

    // The card this user works on: the card open in the dialog, else the card being dragged. Peers see it outlined
    // in this user's color, with their name.
    const workingCardId = openCard?.id ?? (dragState.activeType === 'task' ? dragState.activeId : null);
    const presenceCardIds = useMemo(() => (workingCardId ? [workingCardId] : []), [workingCardId]);
    useStickiesPresence(provider, user, presenceCardIds);
    const cardPresence = useCardPresence(provider);

    // The undo keys are off while a dialog is open, such as the card editor, so ⌘Z there never undoes the board.
    const dialogOpen = useDialogOpen();
    useYjsUndoHotkeys(undoManager, canWrite && !dialogOpen);

    const { isMobile } = useLayout();
    const [editColumnId, setEditColumnId] = useState<string | null>(null);
    // The board shows resolved cards too by default, and clearing the filter returns to that.
    const commentFilter = useCommentFilter({ status: 'all' });
    const currentUserEmail = user?.email ?? '';
    const isCardVisible = useCallback(
        (card: CommentCard) => matchesCommentFilter(card, entryOf(card), commentFilter.filter, currentUserEmail),
        [entryOf, commentFilter.filter, currentUserEmail],
    );
    const [activityPanelOpen, setActivityPanelOpen] = useState(false);
    const cardContextMenu = useContextMenu<CommentContextMenuItem>();

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

    const [addOpen, setAddOpen] = useState(false);
    const [addTargetColumn, setAddTargetColumn] = useState<string | null>(null);
    // Bumped after each successful add so the target column scrolls its newly-inserted top card into view.
    const [scrollToTopOf, setScrollToTopOf] = useState<{ columnId: string; n: number } | null>(null);

    const onSaveNew = useCallback(
        async (patch: CardFormPatch, attachments?: CardAttachmentDraft[], assignee?: string | null) => {
            if (!yjsDoc || !addTargetColumn) return;
            const targetColumnId = addTargetColumn;
            const card = await createCard({ ...patch, attachments }, (card) => {
                getIdArray(getItemMapRoot(yjsDoc, 'columns').get(targetColumnId), 'taskIds')?.insert(0, [card.id]);
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
            handleContextMenu(e, { card, entry: entryOf(card) });
        },
        [handleContextMenu, entryOf],
    );
    // A long-press opens the same card menu on touch, because a `touch-none` card gets no native context menu.
    const handleCardLongPress = useCallback(
        (card: CommentCard, x: number, y: number) => {
            openCardContextMenuAt({ card, entry: entryOf(card) }, x, y);
        },
        [openCardContextMenuAt, entryOf],
    );

    // Each column keeps its card array while its cards and the filter stay the same, so a memoized column renders
    // again only for its own changes.
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
        if (dragState.activeType === 'task') {
            const card = dragState.activeItem;
            return (
                <CommentNoteCard
                    card={card}
                    entry={entryOf(card)}
                    title={card.title}
                    unread={!!card.chatName && unreadChatNames.has(card.chatName)}
                    className={isMobile ? 'w-full' : 'w-[254px]'}
                />
            );
        }

        if (dragState.activeType === 'column') {
            const column = dragState.activeItem;
            return (
                <Column
                    column={column}
                    cards={column.taskIds.map((taskId) => cards[taskId])}
                    entryByChatName={entryByChatName}
                    unreadChatNames={unreadChatNames}
                    canWrite={canWrite}
                    onAddCard={handleAddCard}
                    onEditColumn={handleEditColumn}
                    isMobile={isMobile}
                />
            );
        }

        return null;
    };

    // `loaded` stays true once set, so a dropped connection keeps the board mounted. `isSynced` still gates the
    // presence and the seeding of a new board.
    return (
        <CollabDocumentGate collab={{ loaded, storageUnavailable, storageGone }} path={path} canWrite={canWrite}>
            <UnsyncedEditsGuard active={unsyncedEdits} />
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
                                    offline={offline}
                                    storageUnavailable={storageUnavailable}
                                    undoManager={undoManager}
                                    onAccessDialogOpen={onAccessDialogOpen}
                                    onAddColumn={() => setIsAddColumnDialogOpen(true)}
                                    filter={commentFilter}
                                    members={members}
                                    currentUserEmail={currentUserEmail}
                                    // The panel only renders off mobile, so the toggle is offered only there.
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
                                        <div className="flex gap-0 h-full bg-muted">
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
                                                            unreadChatNames={unreadChatNames}
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
                                                            cardPresence={cardPresence}
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
                                        onOpenChange={(open) => {
                                            setAddOpen(open);
                                            if (!open) setAddTargetColumn(null);
                                        }}
                                        onSave={onSaveNew}
                                        allowAttachments={!!mediaFolderId}
                                        members={members}
                                        currentUserEmail={user?.email}
                                        dialogTitle="Add sticky"
                                        submitLabel="Add sticky"
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
                                            columnTitle={board.columns[editColumnId]?.title ?? ''}
                                            cardCount={board.columns[editColumnId]?.taskIds.length ?? 0}
                                            yjsDoc={yjsDoc}
                                            undoManager={undoManager}
                                        />
                                    )}

                                    <CommentLifecycleDialogs
                                        lifecycle={lifecycle}
                                        path={path}
                                        canWrite={canWrite}
                                        commentContextMenu={cardContextMenu}
                                        onDelete={(cardId) => {
                                            const removed = cards[cardId];
                                            deleteCardFromBoard(cardId);
                                            recordHistory.mutate({
                                                eventType: 'sticky-removed',
                                                details: { card: removed?.title ?? '', cardId },
                                            });
                                        }}
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
                                        onOpenChat={openChat}
                                    />
                                )}
                            </div>
                        </LayoutColumn>
                    </DocSearchProvider>
                </div>
            </ColumnLayout>
        </CollabDocumentGate>
    );
}
