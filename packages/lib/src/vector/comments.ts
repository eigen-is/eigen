// Comment anchoring on the canvas. An element's `commentCardIds` is a JSON id list (the scalar-only
// stored-field rule), and these are the two questions every host asks of it: what text describes an
// anchored card, and which element does a card open on. Adding and removing an id is a plain
// parseIdList/serializeIdList round trip the host does inline.

import { ELEMENT_KINDS } from './kinds';
import { parseIdList, type VectorElement } from './types';

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

// The element a card reveals. undefined ⇒ the card is document-level: a card whose element was deleted
// degrades to document-level rather than vanishing from the panel.
export function elementForCommentCard(elements: VectorElement[], cardId: string): VectorElement | undefined {
    return elements.find((el) => parseIdList(el.commentCardIds).includes(cardId));
}
