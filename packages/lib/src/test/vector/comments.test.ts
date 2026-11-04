import { describe, expect, test } from 'bun:test';
import type { CommentCard } from '../../types/comments';
import { activeCommentCardIds, commentAnchorTexts, elementForCommentCard } from '../../vector/comments';
import type { VectorElement } from '../../vector/types';
import { arrow, shape, textBox } from './element-factories';

// The host's label table in miniature — the panel row's fallback when a kind carries no text.
const labelOf = (el: VectorElement): string =>
    el.type === 'arrow' ? 'Arrow' : el.type === 'rectangle' && el.autoFit ? 'Text' : 'Rectangle';

describe('commentAnchorTexts', () => {
    test('anchor text comes from the element the card is on', () => {
        const els = [
            textBox({ id: 'a', commentCardIds: '["c1"]', html: '<p>Budget for Q3</p>' }),
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
        const el = textBox({ id: 'a', commentCardIds: '["c1"]', html: '<p>   </p>' });
        expect(commentAnchorTexts([el], labelOf).get('c1')).toBe('Text');
    });

    test('anchor text is capped at 100 characters', () => {
        const el = textBox({ id: 'a', commentCardIds: '["c1"]', html: `<p>${'x'.repeat(200)}</p>` });
        expect(commentAnchorTexts([el], labelOf).get('c1')?.length).toBe(100);
    });

    test('the first element holding a card wins the anchor', () => {
        const els = [
            textBox({ id: 'a', index: 'a0', commentCardIds: '["c1"]', html: '<p>first</p>' }),
            textBox({ id: 'b', index: 'a1', commentCardIds: '["c1"]', html: '<p>second</p>' }),
        ];
        expect(commentAnchorTexts(els, labelOf).get('c1')).toBe('first');
    });

    test('one element can anchor several cards', () => {
        const texts = commentAnchorTexts(
            [textBox({ id: 'a', commentCardIds: '["c1","c2"]', html: '<p>hi</p>' })],
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

describe('activeCommentCardIds', () => {
    const card = (id: string, deletedAt?: number): CommentCard => ({ id, title: id, description: '', deletedAt });
    const cards = {
        anchored: card('anchored'),
        documentLevel: card('documentLevel'),
        deleted: card('deleted', 1),
        restored: card('restored', 1),
    };
    const els = [shape({ id: 'a', type: 'rectangle', commentCardIds: '["anchored","restored"]' })];

    test('a card an element anchors is active', () => {
        expect(activeCommentCardIds(els, cards).has('anchored')).toBe(true);
    });

    test('a card no element anchors is a document-level comment while it is not deleted', () => {
        expect(activeCommentCardIds(els, cards).has('documentLevel')).toBe(true);
    });

    test('a deleted card no element anchors is not active', () => {
        expect(activeCommentCardIds(els, cards).has('deleted')).toBe(false);
    });

    // An undo or a version restore that brings the element's anchor back brings the deleted card back with it.
    test('a deleted card an element anchors is active', () => {
        expect(activeCommentCardIds(els, cards).has('restored')).toBe(true);
    });

    test('an anchor to a card the map does not hold is not a card', () => {
        const orphan = [shape({ id: 'b', type: 'rectangle', commentCardIds: '["gone"]' })];
        expect([...activeCommentCardIds(orphan, {})]).toEqual([]);
    });
});
