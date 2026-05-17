import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { writeCardToDoc } from './use-create-comment-card';
import { deleteCardFromDoc } from './use-delete-comment-card';

describe('deleteCardFromDoc', () => {
    test('removes the card from the named map', () => {
        const doc = new Y.Doc();
        writeCardToDoc(doc, 'comments', { id: 'c1', title: 'a', description: '', chatName: 'c.eigenchat' });
        writeCardToDoc(doc, 'comments', { id: 'c2', title: 'b', description: '' });

        deleteCardFromDoc(doc, 'comments', 'c1');

        expect(doc.getMap('comments').has('c1')).toBe(false);
        expect(doc.getMap('comments').has('c2')).toBe(true);
    });

    test('no-op when cardId is missing', () => {
        const doc = new Y.Doc();
        writeCardToDoc(doc, 'comments', { id: 'c1', title: 'a', description: '' });
        deleteCardFromDoc(doc, 'comments', 'unknown');
        expect(doc.getMap('comments').has('c1')).toBe(true);
    });
});
