import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { CreateCommentCardInput } from '@workspace/lib/comments';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { FileEventDetailsMap } from '@workspace/lib/types/file-history';
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { normalizeBoard } from '../normalize-board';
import type { BoardData, ColumnItem } from '../types';

type DragState = {
    activeId: string | null;
    activeType: 'task' | 'column' | null;
    activeItem: CommentCard | ColumnItem | null;
};

type UseDragAndDropProps = {
    board: BoardData;
    cards: Record<string, CommentCard>;
    yjsDoc: Y.Doc | null;
    // Seals the drag-end commit as its own undo step.
    undoManager: Y.UndoManager | null;
    // Alt-drag duplicate goes through the frozen createCard seam: a fresh chatName, the
    // new card id anchored at the drop slot in ONE transact.
    createCard: (
        input: CreateCommentCardInput,
        anchorInTransact?: (card: CommentCard) => void,
    ) => Promise<CommentCard | undefined>;
    // cardId required: the write contract (POST /history typebox), not the optional read shape.
    onRecordEvent?: (
        event:
            | { eventType: 'sticky-moved'; details: FileEventDetailsMap['sticky-moved'] & { cardId: string } }
            | { eventType: 'sticky-added'; details: FileEventDetailsMap['sticky-added'] & { cardId: string } },
    ) => void;
};

export const useDragAndDrop = ({
    board,
    cards,
    yjsDoc,
    undoManager,
    createCard,
    onRecordEvent,
}: UseDragAndDropProps) => {
    const [dragState, setDragState] = useState<DragState>({
        activeId: null,
        activeType: null,
        activeItem: null,
    });

    // dnd-kit's DragEndEvent carries no drop-time modifier state, so track Alt globally and read it at
    // drop (Alt held AT DROP → duplicate the card, original stays).
    const altHeldRef = useRef(false);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            altHeldRef.current = e.altKey;
        };
        // Alt+Tab (Win/Linux) lets the OS eat the keyup, stranding the ref true — a later plain drag
        // would silently duplicate. Reset on focus loss / tab hide (vector binds window blur for the
        // same class of stuck-modifier bug).
        const onBlur = () => {
            altHeldRef.current = false;
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('keyup', onKey);
        window.addEventListener('blur', onBlur);
        document.addEventListener('visibilitychange', onBlur);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('keyup', onKey);
            window.removeEventListener('blur', onBlur);
            document.removeEventListener('visibilitychange', onBlur);
        };
    }, []);

    const findColumnOfTask = (taskId: string): string | null => {
        for (const columnId in board.columns) {
            if (board.columns[columnId].taskIds.includes(taskId)) return columnId;
        }
        return null;
    };

    const resetDragState = () => setDragState({ activeId: null, activeType: null, activeItem: null });

    const handleDragStart = (event: DragStartEvent) => {
        const activeId = event.active.id as string;
        if (activeId in cards) {
            setDragState({ activeId, activeType: 'task', activeItem: cards[activeId] });
        } else if (activeId in board.columns) {
            setDragState({ activeId, activeType: 'column', activeItem: board.columns[activeId] });
        }
    };

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || !yjsDoc) {
            resetDragState();
            return;
        }
        const activeId = active.id as string;
        const overId = over.id as string;
        const columnsMap = yjsDoc.getMap('columns');
        const columnOrderArray = yjsDoc.getArray('columnOrder');

        // Alt-drag duplicate: a COPY of the dragged CARD lands at the drop slot, the
        // original stays put. It goes through the frozen createCard seam — a fresh chatName (a card's
        // chatName binds its own comment thread, never copied); title/description/color/attachments are
        // copied (attachments may reference the same media files, safe to share); the new id is anchored
        // in createCard's own transact (one undo step).
        const source = cards[activeId];
        if (altHeldRef.current && dragState.activeType === 'task' && source) {
            const overIsColumn = overId in board.columns;
            const destColumnId = overIsColumn ? overId : findColumnOfTask(overId);
            if (destColumnId) {
                undoManager?.stopCapturing();
                createCard(
                    {
                        title: source.title,
                        description: source.description,
                        color: source.color,
                        attachments: source.attachments,
                    },
                    (card) => {
                        const destTaskIds = (columnsMap.get(destColumnId) as Y.Map<unknown> | undefined)?.get(
                            'taskIds',
                        ) as Y.Array<string> | undefined;
                        if (!destTaskIds) return;
                        const at = overIsColumn
                            ? destTaskIds.length
                            : (destTaskIds.toArray() as string[]).indexOf(overId);
                        destTaskIds.insert(at === -1 ? destTaskIds.length : at, [card.id]);
                    },
                )
                    .then((created) => {
                        undoManager?.stopCapturing();
                        // Parity with the dialog add — duplicates show in file history too.
                        if (created) {
                            onRecordEvent?.({
                                eventType: 'sticky-added',
                                details: {
                                    card: source.title,
                                    toColumn: board.columns[destColumnId]?.title ?? '',
                                    cardId: created.id,
                                },
                            });
                        }
                    })
                    .catch(() => {});
            }
            resetDragState();
            return;
        }

        undoManager?.stopCapturing();
        const movedColumns = yjsDoc.transact(() => {
            let moved: { oldColumn: string; newColumn: string } | null = null;
            if (dragState.activeType === 'column') {
                if (activeId !== overId) {
                    const currentOrder = columnOrderArray.toArray() as string[];
                    const oldIndex = currentOrder.indexOf(activeId);
                    const newIndex = currentOrder.indexOf(overId);
                    if (oldIndex !== -1 && newIndex !== -1) {
                        columnOrderArray.delete(0, columnOrderArray.length);
                        const newOrder = [...currentOrder];
                        newOrder.splice(oldIndex, 1);
                        newOrder.splice(newIndex, 0, activeId);
                        columnOrderArray.insert(0, newOrder);
                    }
                }
            } else if (dragState.activeType === 'task') {
                const overIsColumn = overId in board.columns;
                const sourceColumnId = findColumnOfTask(activeId);
                const destColumnId = overIsColumn ? overId : findColumnOfTask(overId);
                // Dropping on a column appends; dropping back onto the own column header is a no-op.
                if (sourceColumnId && destColumnId && !(overIsColumn && destColumnId === sourceColumnId)) {
                    const sourceTaskIds = (columnsMap.get(sourceColumnId) as Y.Map<unknown> | undefined)?.get(
                        'taskIds',
                    ) as Y.Array<string> | undefined;
                    const destTaskIds =
                        sourceColumnId === destColumnId
                            ? sourceTaskIds
                            : ((columnsMap.get(destColumnId) as Y.Map<unknown> | undefined)?.get('taskIds') as
                                  | Y.Array<string>
                                  | undefined);
                    if (sourceTaskIds && destTaskIds) {
                        const sourceIndex = (sourceTaskIds.toArray() as string[]).indexOf(activeId);
                        const destIndex = overIsColumn
                            ? destTaskIds.length
                            : (destTaskIds.toArray() as string[]).indexOf(overId);
                        if (sourceIndex !== -1 && destIndex !== -1) {
                            sourceTaskIds.delete(sourceIndex, 1);
                            destTaskIds.insert(destIndex, [activeId]);
                            if (sourceColumnId !== destColumnId) {
                                moved = { oldColumn: sourceColumnId, newColumn: destColumnId };
                            }
                        }
                    }
                }
            }
            normalizeBoard(yjsDoc);
            return moved;
        });
        undoManager?.stopCapturing();
        if (movedColumns) {
            onRecordEvent?.({
                eventType: 'sticky-moved',
                details: {
                    card: cards[activeId]?.title ?? '',
                    toColumn: board.columns[movedColumns.newColumn]?.title ?? '',
                    cardId: activeId,
                },
            });
        }
        resetDragState();
    };

    return {
        dragState,
        handleDragStart,
        handleDragEnd,
    };
};
