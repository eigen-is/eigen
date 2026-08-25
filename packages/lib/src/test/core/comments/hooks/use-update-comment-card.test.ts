import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { writeCardToDoc } from '../../../../core/comments/hooks/use-create-comment-card';
import { applyCardPatch } from '../../../../core/comments/hooks/use-update-comment-card';

describe('applyCardPatch', () => {
    function seed(): Y.Doc {
        const doc = new Y.Doc();
        writeCardToDoc(doc, 'comments', {
            id: 'c1',
            title: 'orig',
            description: 'desc',
            color: '#ff0000',
            chatName: 'c.eigenchat',
        });
        return doc;
    }

    test('updates title and description independently', () => {
        const doc = seed();
        applyCardPatch(doc, 'comments', 'c1', { title: 'new title' });
        const y = doc.getMap<Y.Map<unknown>>('comments').get('c1')!;
        expect(y.get('title')).toBe('new title');
        expect(y.get('description')).toBe('desc');
    });

    test('color: string sets; undefined leaves untouched', () => {
        const doc = seed();
        applyCardPatch(doc, 'comments', 'c1', { color: '#00ff00' });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('color')).toBe('#00ff00');

        applyCardPatch(doc, 'comments', 'c1', { title: 'x' });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('color')).toBe('#00ff00');
    });

    test('attachments: sets the array and deletes the key when emptied', () => {
        const doc = seed();
        applyCardPatch(doc, 'comments', 'c1', { attachments: ['a.png'] });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('attachments')).toEqual(['a.png']);

        applyCardPatch(doc, 'comments', 'c1', { title: 'x' });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('attachments')).toEqual(['a.png']);

        applyCardPatch(doc, 'comments', 'c1', { attachments: [] });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.has('attachments')).toBe(false);
    });

    test('no-op when cardId is missing', () => {
        const doc = seed();
        applyCardPatch(doc, 'comments', 'unknown', { title: 'x' });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('title')).toBe('orig');
    });
});
