import type { ActiveComments, CommentCard } from '@workspace/lib/types/comments';
import { commentAnchorTexts, type VectorElement } from '@workspace/lib/vector';
import { useMemo } from 'react';
import { ELEMENT_KIND_UI } from '../kinds';

// The canvas' ActiveComments: every card in the document's `comments` map is active (D2.13 — a card
// whose element was deleted degrades to a document-level comment rather than vanishing from the
// panel), and an element that claims a card gives it an anchor text. Pass the elements in z-order;
// a kind with no text of its own falls back to its UI label, so a panel row is never blank.
export function useCanvasComments(elements: VectorElement[], cards: Record<string, CommentCard>): ActiveComments {
    return useMemo(
        () => ({
            ids: new Set(Object.keys(cards)),
            anchorTexts: commentAnchorTexts(elements, (el) => ELEMENT_KIND_UI[el.type].label),
        }),
        [elements, cards],
    );
}
