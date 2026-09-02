import { useCallback } from 'react';
import type * as Y from 'yjs';
import type { ChatAttachment } from '../../../types/chat';
import { getItemMapRoot } from '../../collab/yjs-utils';

export type CommentCardPatch = {
    title?: string;
    description?: string;
    color?: string;
    attachments?: ChatAttachment[];
};

export function applyCardPatch(doc: Y.Doc, mapName: string, cardId: string, patch: CommentCardPatch): void {
    const card = getItemMapRoot(doc, mapName).get(cardId);
    if (!card) return;
    doc.transact(() => {
        if (patch.title !== undefined) card.set('title', patch.title);
        if (patch.description !== undefined) card.set('description', patch.description);
        if (patch.color !== undefined) card.set('color', patch.color);
        if (patch.attachments !== undefined) {
            if (patch.attachments.length > 0) card.set('attachments', patch.attachments);
            else card.delete('attachments');
        }
    });
}

export function useUpdateCommentCard(doc: Y.Doc | null, mapName: 'comments' | 'tasks' = 'comments') {
    return useCallback(
        (cardId: string, patch: CommentCardPatch): void => {
            if (!doc) return;
            applyCardPatch(doc, mapName, cardId, patch);
        },
        [doc, mapName],
    );
}
