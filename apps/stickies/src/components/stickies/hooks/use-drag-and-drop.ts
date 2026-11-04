// Dragging on a Stickies board: a card to another place or column, a column to another place, and an Alt-drop that
// leaves a copy of the card where it lands. Each drop is one Yjs transaction and one undo step, and a move or a copy
// is recorded in the file's history. The board passes in what it shows, and renders the dragged item from the state
// this returns.

import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { getIdArray, getIdArrayRoot, getItemMapRoot } from '@workspace/lib/collab';
import type { CreateCommentCardInput } from '@workspace/lib/comments';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { FileEventDetailsMap } from '@workspace/lib/types/file-history';
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { normalizeBoard } from '../normalize-board';
import type { BoardData, ColumnItem } from '../types';

type DragState =
    | { activeId: string; activeType: 'task'; activeItem: CommentCard }
    | { activeId: string; activeType: 'column'; activeItem: ColumnItem }
    | { activeId: null; activeType: null; activeItem: null };

type UseDragAndDropProps = {
    board: BoardData;
    cards: Record<string, CommentCard>;
    yjsDoc: Y.Doc | null;
    // Seals the drag-end commit as its own undo step.
    undoManager: Y.UndoManager | null;
    // An Alt-drop copies the card through createCard: a fresh chatName, and the new id lands at the drop slot in the
    // same transaction.
    createCard: (
        input: CreateCommentCardInput,
        anchorInTransact?: (card: CommentCard) => void,
    ) => Promise<CommentCard | undefined>;
    // The history route requires a cardId, which the event's read shape leaves optional.
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
}: UseDragAndDropProps): {
    dragState: DragState;
    handleDragStart: (event: DragStartEvent) => void;
    handleDragEnd: (event: DragEndEvent) => void;
} => {
    const [dragState, setDragState] = useState<DragState>({
        activeId: null,
        activeType: null,
        activeItem: null,
    });

    // dnd-kit's DragEndEvent says nothing about the keys held at the drop, so the hook tracks Alt itself. Alt held at
    // the drop copies the card, and the original stays.
    const altHeldRef = useRef(false);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            altHeldRef.current = e.altKey;
        };
        // On Windows and Linux, Alt+Tab lets the system swallow the keyup, and a later plain drag would copy. So losing
        // focus or hiding the tab clears it.
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
        const activeId = String(event.active.id);
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
        const activeId = String(active.id);
        const overId = String(over.id);
        const columnsMap = getItemMapRoot(yjsDoc, 'columns');
        const columnOrderArray = getIdArrayRoot(yjsDoc, 'columnOrder');

        // An Alt-drop puts a copy of the card at the drop slot and leaves the original. The copy gets a thread of its
        // own, because a chatName names one card's thread. Its title, description, color and attachments are copied,
        // and the attachments may share their media files. createCard places the copy in its own transaction.
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
                        const destTaskIds = getIdArray(columnsMap.get(destColumnId), 'taskIds');
                        if (!destTaskIds) return;
                        const at = overIsColumn ? destTaskIds.length : destTaskIds.toArray().indexOf(overId);
                        destTaskIds.insert(at === -1 ? destTaskIds.length : at, [card.id]);
                    },
                )
                    .then((created) => {
                        undoManager?.stopCapturing();
                        // A copy shows in the file's history, as a card added through the dialog does.
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
                    const currentOrder = columnOrderArray.toArray();
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
                    const sourceColumn = columnsMap.get(sourceColumnId);
                    const sourceTaskIds = getIdArray(sourceColumn, 'taskIds');
                    const destColumn = sourceColumnId === destColumnId ? sourceColumn : columnsMap.get(destColumnId);
                    const destTaskIds = getIdArray(destColumn, 'taskIds');
                    if (sourceTaskIds && destTaskIds) {
                        const sourceIndex = sourceTaskIds.toArray().indexOf(activeId);
                        const destIndex = overIsColumn ? destTaskIds.length : destTaskIds.toArray().indexOf(overId);
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
