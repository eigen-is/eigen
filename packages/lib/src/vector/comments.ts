// Comment anchoring on the canvas. An element keeps the cards it anchors in `commentCardIds`, a JSON list of ids,
// because every stored field is a scalar or a string. These are the questions every canvas host asks of it, such as
// which cards are in use and which element a card opens on. They are pure reads of the scene and the cards, so the
// server can ask them too.

import type { CommentCard } from '../types/comments';
import type { VectorElement } from './types';
import { parseIdList } from './types';

// The element a card reveals, or undefined for a card no element anchors.
export function elementForCommentCard(elements: readonly VectorElement[], cardId: string): VectorElement | undefined {
    return elements.find((el) => parseIdList(el.commentCardIds).includes(cardId));
}

// A card an element anchors is in use even if deleted, so an undo or a restore that brings the anchor back brings the
// card back too. A card no element anchors is a document-level comment until someone deletes it.
export function activeCommentCardIds(
    elements: readonly VectorElement[],
    cards: Readonly<Record<string, CommentCard>>,
): Set<string> {
    const anchored = new Set(elements.flatMap((el) => parseIdList(el.commentCardIds)));
    const active = Object.values(cards).filter((card) => anchored.has(card.id) || card.deletedAt === undefined);
    return new Set(active.map((card) => card.id));
}
