// Saves a comment card's edit into the Y.Doc: the fields the patch names, in one transaction. The attachments change
// the list the doc holds at that moment, so an upload that lands late keeps what a peer or the user changed meanwhile,
// and an emptied list clears the field. The comment lifecycle hands it to the card dialog.

import { useCallback } from 'react';
import * as Y from 'yjs';
import type { CommentCardPatch, CommentMapName } from '../../../types/comments';
import { getItemMapRoot } from '../../collab/yjs-utils';
import { readCardAttachments } from './use-comment-cards';

export function useUpdateCommentCard(
    doc: Y.Doc | null,
    mapName: CommentMapName = 'comments',
): (cardId: string, patch: CommentCardPatch) => void {
    return useCallback(
        (cardId: string, patch: CommentCardPatch): void => {
            if (!doc) return;
            const card = getItemMapRoot(doc, mapName).get(cardId);
            if (!(card instanceof Y.Map)) return;
            doc.transact(() => {
                if (patch.title !== undefined) card.set('title', patch.title);
                if (patch.description !== undefined) card.set('description', patch.description);
                if (patch.color !== undefined) card.set('color', patch.color);
                if (patch.attachments) {
                    const next = patch.attachments(readCardAttachments(card.get('attachments')) ?? []);
                    if (next.length > 0) card.set('attachments', next);
                    else card.delete('attachments');
                }
            });
        },
        [doc, mapName],
    );
}
