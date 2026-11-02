// A canvas's comment state for the comments panel: which cards are active, and the text each card's anchor shows,
// taken from the element that claims it. A comment host calls it with the scene's elements in z-order.

import type { ActiveComments, CommentCard } from '@workspace/lib/types/comments';
import type { VectorElement } from '@workspace/lib/vector';
import { commentAnchorTexts } from '@workspace/lib/vector';
import { useMemo } from 'react';
import { elementLabel } from '../kinds';

// Every card in the document's `comments` map is active. A card whose element was deleted stays in the panel as a
// comment on the document. An element with no text of its own gives its card its label, such as Rectangle or Text, so a
// panel row is never blank.
export function useCanvasComments(elements: VectorElement[], cards: Record<string, CommentCard>): ActiveComments {
    return useMemo(
        () => ({
            ids: new Set(Object.keys(cards)),
            anchorTexts: commentAnchorTexts(elements, elementLabel),
        }),
        [elements, cards],
    );
}
