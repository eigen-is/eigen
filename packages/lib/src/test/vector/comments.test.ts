import { describe, expect, test } from 'bun:test';
import type { CommentCard } from '../../types/comments';
import { activeCommentCardIds, elementForCommentCard } from '../../vector/comments';
import { shape } from './element-factories';

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
