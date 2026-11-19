import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import * as Y from 'yjs';
import { writeCardToDoc } from '../../../../core/comments/hooks/use-create-comment-card';
import { useUpdateCommentCard } from '../../../../core/comments/hooks/use-update-comment-card';
import type { CommentCardPatch } from '../../../../types/comments';
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

    test('attachments change the list as it stands in the doc, and an emptied list deletes the key', async () => {
        const doc = seed();
        const y = doc.getMap<Y.Map<unknown>>('comments').get('c1')!;
        await updateCard(doc, 'c1', { attachments: (current) => [...current, 'a.png'] });
        expect(y.get('attachments')).toEqual(['a.png']);

        // A peer attached a file since this dialog last drew the card, so the add keeps it.
        y.set('attachments', ['a.png', 'peer.png']);
        await updateCard(doc, 'c1', { attachments: (current) => [...current, 'b.png'] });
        expect(y.get('attachments')).toEqual(['a.png', 'peer.png', 'b.png']);

        await updateCard(doc, 'c1', { title: 'x' });
        expect(y.get('attachments')).toEqual(['a.png', 'peer.png', 'b.png']);

        await updateCard(doc, 'c1', { attachments: () => [] });
        expect(y.has('attachments')).toBe(false);
    });

    test("a peer's malformed list reads as the valid entries it holds", async () => {
        const doc = seed();
        const y = doc.getMap<Y.Map<unknown>>('comments').get('c1')!;
        y.set('attachments', ['a.png', 42, null]);
        await updateCard(doc, 'c1', { attachments: (current) => [...current, 'b.png'] });
        expect(y.get('attachments')).toEqual(['a.png', 'b.png']);
    });

    test('no-op when cardId is missing', async () => {
        const doc = seed();
        await updateCard(doc, 'unknown', { title: 'x' });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c1')!.get('title')).toBe('orig');
    });
});
