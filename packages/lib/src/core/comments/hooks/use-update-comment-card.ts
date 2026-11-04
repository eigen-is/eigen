// Saves a comment card's edit into the Y.Doc: the fields the patch names, in one transaction, and an empty
// attachment list clears the field. The comment lifecycle hands it to the card dialog. applyCardPatch is the plain
// write it wraps.

import { useCallback } from 'react';
import * as Y from 'yjs';
import type { ChatAttachment } from '../../../types/chat';
import type { CommentMapName } from '../../../types/comments';
import { getItemMapRoot } from '../../collab/yjs-utils';

export type CommentCardPatch = {
    title?: string;
    description?: string;
    color?: string;
    attachments?: ChatAttachment[];
};

export function applyCardPatch(doc: Y.Doc, mapName: CommentMapName, cardId: string, patch: CommentCardPatch): void {
    const card = getItemMapRoot(doc, mapName).get(cardId);
    if (!(card instanceof Y.Map)) return;
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

export function useUpdateCommentCard(doc: Y.Doc | null, mapName: CommentMapName = 'comments') {
    return useCallback(
        (cardId: string, patch: CommentCardPatch): void => {
            if (!doc) return;
            applyCardPatch(doc, mapName, cardId, patch);
        },
        [doc, mapName],
    );
}
