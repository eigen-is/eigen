import { describe, expect, test } from 'bun:test';
import { commentAnchorTexts, elementForCommentCard } from '../../vector/comments';
import {
    DEFAULT_ARROW_PROPS,
    DEFAULT_ELEMENT_PROPS,
    DEFAULT_SKETCH_PROPS,
    type VectorArrowElement,
    type VectorElement,
} from '../../vector/types';
import { richtext, shape } from './element-factories';

// The host's label table in miniature — the panel row's fallback when a kind carries no text.
const labelOf = (el: VectorElement): string =>
    el.type === 'arrow' ? 'Arrow' : el.type === 'richtext' ? 'Text' : 'Rectangle';

function arrow(over: Partial<VectorArrowElement> & Pick<VectorArrowElement, 'id'>): VectorArrowElement {
    return {
        ...DEFAULT_ELEMENT_PROPS,
        ...DEFAULT_SKETCH_PROPS,
        ...DEFAULT_ARROW_PROPS,
        type: 'arrow',
        x: 0,
        y: 0,
        width: 100,
        height: 60,
        angle: 0,
        index: 'a0',
        points: '[[0,0],[100,60]]',
        ...over,
    };
}

describe('commentAnchorTexts', () => {
    test('anchor text comes from the element the card is on', () => {
        const els = [
            richtext({ id: 'a', commentCardIds: '["c1"]', html: '<p>Budget for Q3</p>' }),
            shape({ id: 'b', type: 'rectangle', commentCardIds: '["c2"]' }),
        ];
        const texts = commentAnchorTexts(els, labelOf);
        expect(texts.get('c1')).toBe('Budget for Q3');
        // A kind with no text falls back to its label, so the panel row is never blank.
        expect(texts.get('c2')).toBe('Rectangle');
    });

    test('an arrow anchors on its label', () => {
        const texts = commentAnchorTexts([arrow({ id: 'ar', commentCardIds: '["c1"]', text: 'ships to' })], labelOf);
        expect(texts.get('c1')).toBe('ships to');
    });

    test('a labelless arrow falls back to its kind label', () => {
        expect(commentAnchorTexts([arrow({ id: 'ar', commentCardIds: '["c1"]' })], labelOf).get('c1')).toBe('Arrow');
    });

    test('whitespace-only text falls back to the label', () => {
        const el = richtext({ id: 'a', commentCardIds: '["c1"]', html: '<p>   </p>' });
        expect(commentAnchorTexts([el], labelOf).get('c1')).toBe('Text');
    });

    test('anchor text is capped at 100 characters', () => {
        const el = richtext({ id: 'a', commentCardIds: '["c1"]', html: `<p>${'x'.repeat(200)}</p>` });
        expect(commentAnchorTexts([el], labelOf).get('c1')?.length).toBe(100);
    });

    test('the first element holding a card wins the anchor', () => {
        const els = [
            richtext({ id: 'a', index: 'a0', commentCardIds: '["c1"]', html: '<p>first</p>' }),
            richtext({ id: 'b', index: 'a1', commentCardIds: '["c1"]', html: '<p>second</p>' }),
        ];
        expect(commentAnchorTexts(els, labelOf).get('c1')).toBe('first');
    });

    test('one element can anchor several cards', () => {
        const texts = commentAnchorTexts(
            [richtext({ id: 'a', commentCardIds: '["c1","c2"]', html: '<p>hi</p>' })],
            labelOf,
        );
        expect([...texts.entries()]).toEqual([
            ['c1', 'hi'],
            ['c2', 'hi'],
        ]);
    });

    test('unanchored and malformed lists contribute nothing', () => {
        const els = [
            shape({ id: 'a', type: 'rectangle' }),
            shape({ id: 'b', type: 'rectangle', commentCardIds: 'not json' }),
        ];
        expect(commentAnchorTexts(els, labelOf).size).toBe(0);
    });
});

describe('elementForCommentCard', () => {
    test('finds the element a card opens on', () => {
        const els = [
            shape({ id: 'a', type: 'rectangle' }),
            shape({ id: 'b', type: 'rectangle', commentCardIds: '["c9"]' }),
        ];
        expect(elementForCommentCard(els, 'c9')?.id).toBe('b');
        expect(elementForCommentCard(els, 'nope')).toBeUndefined();
    });

    test('a card no element claims is document-level', () => {
        expect(elementForCommentCard([shape({ id: 'a', type: 'rectangle' })], 'c1')).toBeUndefined();
    });
});
