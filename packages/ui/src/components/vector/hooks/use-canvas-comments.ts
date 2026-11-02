// The canvas's comment state for the comments panel: which cards are active, and the text each card's anchor shows,
// taken from the element that claims it. The canvas's comment host calls it with the scene's elements.

import type { ActiveComments, CommentCard } from '@workspace/lib/types/comments';
import type { VectorElement } from '@workspace/lib/vector';
import { commentAnchorTexts } from '@workspace/lib/vector';
import { useMemo } from 'react';
import { elementLabel } from '../kinds';

// The canvas' ActiveComments: every card in the document's `comments` map is active — a card whose
// element was deleted degrades to a document-level comment rather than vanishing from the panel — and
// an element that claims a card gives it an anchor text. Pass the elements in z-order. An element with no
// text of its own falls back to its label, such as Rectangle or Text, so a panel row is never blank.
export function useCanvasComments(elements: VectorElement[], cards: Record<string, CommentCard>): ActiveComments {
    return useMemo(
        () => ({
            ids: new Set(Object.keys(cards)),
            anchorTexts: commentAnchorTexts(elements, elementLabel),
        }),
        [elements, cards],
    );
}
