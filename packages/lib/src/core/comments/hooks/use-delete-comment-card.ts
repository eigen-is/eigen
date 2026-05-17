import { useCallback } from 'react';
import type * as Y from 'yjs';

// Why: removing only from Y.Map preserves .eigenchat + comments.db row so undo/redo and
// Y.Doc version-revert can restore the card. Callers must also remove the anchor
// (mark / commentCardIds / column membership) in the same transaction.
export function deleteCardFromDoc(doc: Y.Doc, mapName: string, cardId: string): void {
    doc.transact(() => {
        doc.getMap<Y.Map<unknown>>(mapName).delete(cardId);
    });
}

export function useDeleteCommentCard(doc: Y.Doc | null, mapName: 'comments' | 'tasks' = 'comments') {
    return useCallback(
        (cardId: string): void => {
            if (!doc) return;
            deleteCardFromDoc(doc, mapName, cardId);
        },
        [doc, mapName],
    );
}
