// Comment anchoring on the canvas. An element keeps the cards it anchors in `commentCardIds`, a JSON list of ids,
// because every stored field is a scalar or a string. These are the questions every canvas host asks of it, such as
// which cards are in use, what text describes an anchored card and which element a card opens on. They are pure
// reads of the scene and the cards, so the server can ask them too.

import type { CommentCard } from '../types/comments';
import { ELEMENT_KINDS } from './kinds';
import type { VectorElement } from './types';
import { parseIdList } from './types';

const ANCHOR_TEXT_MAX = 100;

// Panel-row text per anchored card. The first anchor wins, so pass the elements in z-order. A kind with no
// text of its own, such as a shape or an unlabelled arrow, falls back to the host's label, so a row is never blank.
export function commentAnchorTexts(
    elements: readonly VectorElement[],
    labelOf: (el: VectorElement) => string,
): Map<string, string> {
    const texts = new Map<string, string>();
    for (const el of elements) {
        const text = ELEMENT_KINDS[el.type].searchText(el).trim();
        for (const cardId of parseIdList(el.commentCardIds)) {
            if (texts.has(cardId)) continue;
            texts.set(cardId, (text || labelOf(el)).slice(0, ANCHOR_TEXT_MAX));
        }
    }
    return texts;
}

// The element a card reveals, or undefined for a card no element anchors.
export function elementForCommentCard(elements: readonly VectorElement[], cardId: string): VectorElement | undefined {
    return elements.find((el) => parseIdList(el.commentCardIds).includes(cardId));
}

// The cards the comments pane lists. A card is in use while an element anchors it, and a card no element anchors is a
// document-level comment until someone deletes it. So an undo or a version restore that brings an element's anchor
// back brings its card back too, even a deleted one.
export function activeCommentCardIds(
    elements: readonly VectorElement[],
    cards: Readonly<Record<string, CommentCard>>,
): Set<string> {
    const anchored = new Set(elements.flatMap((el) => parseIdList(el.commentCardIds)));
    const active = Object.values(cards).filter((card) => anchored.has(card.id) || card.deletedAt === undefined);
    return new Set(active.map((card) => card.id));
}
