// A canvas's comment state for the comments panel: which cards are active, worked out again when the scene or the
// cards change. A comment host calls it with the scene's elements.

import type { ActiveComments, CommentCard } from '@workspace/lib/types/comments';
import type { VectorElement } from '@workspace/lib/vector';
import { activeCommentCardIds } from '@workspace/lib/vector';
import { useMemo } from 'react';

export function useCanvasComments(
    elements: readonly VectorElement[],
    cards: Readonly<Record<string, CommentCard>>,
): ActiveComments {
    return useMemo(() => ({ ids: activeCommentCardIds(elements, cards) }), [elements, cards]);
}
