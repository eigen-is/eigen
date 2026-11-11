// Saves a comment card's edit into the Y.Doc: the fields the patch names, in one transaction, and an empty
// attachment list clears the field. The comment lifecycle hands it to the card dialog.

import { useCallback } from 'react';
import * as Y from 'yjs';
import type { CardFormPatch, CommentCard, CommentMapName } from '../../../types/comments';
import { getItemMapRoot } from '../../collab/yjs-utils';

// A card form's patch with its attachments, which the dialog resolves before it saves them.
export type CommentCardPatch = CardFormPatch & Pick<CommentCard, 'attachments'>;

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
                if (patch.attachments !== undefined) {
                    if (patch.attachments.length > 0) card.set('attachments', patch.attachments);
                    else card.delete('attachments');
                }
            });
        },
        [doc, mapName],
    );
}
