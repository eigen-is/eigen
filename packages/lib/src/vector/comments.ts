// Comment anchoring on the canvas. An element's `commentCardIds` is a JSON id list (the scalar-only
// stored-field rule), and these are the questions every host asks of it: what text describes an
// anchored card, which element does a card open on, and how does an element gain or lose one.

import { ELEMENT_KINDS } from './kinds';
import { parseIdList, serializeIdList, type VectorElement } from './types';

const ANCHOR_TEXT_MAX = 100;

// Panel-row text per anchored card. First anchor wins, so pass the elements in z-order; a kind with no
// text of its own (a shape, an unlabelled arrow) falls back to the host's label so a row is never blank.
export function commentAnchorTexts(
    elements: VectorElement[],
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

// The element a card reveals. undefined ⇒ the card is document-level (D2.13: a card whose element was
// deleted degrades to document-level rather than vanishing).
export function elementForCommentCard(elements: VectorElement[], cardId: string): VectorElement | undefined {
    return elements.find((el) => parseIdList(el.commentCardIds).includes(cardId));
}

// The element's next commentCardIds value. Idempotent: re-anchoring the same card is a no-op, so a
// double-submit cannot list a card twice.
export function withCommentCard(el: VectorElement, cardId: string): string {
    const ids = parseIdList(el.commentCardIds);
    return serializeIdList(ids.includes(cardId) ? ids : [...ids, cardId]);
}

// The inverse, for the delete path: the last card leaving returns the element to the unanchored ''.
export function withoutCommentCard(el: VectorElement, cardId: string): string {
    return serializeIdList(parseIdList(el.commentCardIds).filter((id) => id !== cardId));
}
