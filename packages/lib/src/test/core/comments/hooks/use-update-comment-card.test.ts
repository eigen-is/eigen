import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import * as Y from 'yjs';
import { writeCardToDoc } from '../../../../core/comments/hooks/use-create-comment-card';
import type { CommentCardPatch } from '../../../../core/comments/hooks/use-update-comment-card';
import { useUpdateCommentCard } from '../../../../core/comments/hooks/use-update-comment-card';
import { installHappyDom } from '../../../happy-dom';
import { renderHook } from '../../../render-hook';

installHappyDom();

describe('useUpdateCommentCard', () => {
    async function updateCard(doc: Y.Doc, cardId: string, patch: CommentCardPatch): Promise<void> {
        const { latest, unmount } = await renderHook(() => useUpdateCommentCard(doc), new QueryClient());
        latest(cardId, patch);
        await unmount();
    }

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

    test('updates title and description independently', async () => {
        const doc = seed();
        await updateCard(doc, 'c1', { title: 'new title' });
        const y = doc.getMap<Y.Map<unknown>>('comments').get('c1')!;
        expect(y.get('title')).toBe('new title');
        expect(y.get('description')).toBe('desc');
    });

    test('color: string sets; undefined leaves untouched', async () => {
        const doc = seed();
        await updateCard(doc, 'c1', { color: '#00ff00' });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('color')).toBe('#00ff00');

        await updateCard(doc, 'c1', { title: 'x' });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('color')).toBe('#00ff00');
    });

    test('attachments: sets the array and deletes the key when emptied', async () => {
        const doc = seed();
        await updateCard(doc, 'c1', { attachments: ['a.png'] });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('attachments')).toEqual(['a.png']);

        await updateCard(doc, 'c1', { title: 'x' });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('attachments')).toEqual(['a.png']);

        await updateCard(doc, 'c1', { attachments: [] });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.has('attachments')).toBe(false);
    });

    test('no-op when cardId is missing', async () => {
        const doc = seed();
        await updateCard(doc, 'unknown', { title: 'x' });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('title')).toBe('orig');
    });
});
