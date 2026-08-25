import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { writeCardToDoc } from '../../../../core/comments/hooks/use-create-comment-card';

describe('writeCardToDoc', () => {
    test('writes id/title/description/color/chatName/creator/createdAt into the named map', () => {
        const doc = new Y.Doc();
        writeCardToDoc(doc, 'comments', {
            id: 'c1',
            title: 't',
            description: 'd',
            color: '#ff0000',
            chatName: 'c1.eigenchat',
            creator: 'alice@example.com',
            createdAt: 1700000000000,
        });
        const y = doc.getMap<Y.Map<unknown>>('comments').get('c1')!;
        expect(y.get('id')).toBe('c1');
        expect(y.get('title')).toBe('t');
        expect(y.get('description')).toBe('d');
        expect(y.get('color')).toBe('#ff0000');
        expect(y.get('chatName')).toBe('c1.eigenchat');
        expect(y.get('creator')).toBe('alice@example.com');
        expect(y.get('createdAt')).toBe(1700000000000);
    });

    test('omits optional fields when not provided', () => {
        const doc = new Y.Doc();
        writeCardToDoc(doc, 'comments', { id: 'c2', title: '', description: '' });
        const y = doc.getMap<Y.Map<unknown>>('comments').get('c2')!;
        expect(y.has('color')).toBe(false);
        expect(y.has('chatName')).toBe(false);
        expect(y.has('creator')).toBe(false);
        expect(y.has('createdAt')).toBe(false);
    });

    test('persists attachments only when non-empty', () => {
        const doc = new Y.Doc();
        writeCardToDoc(doc, 'comments', { id: 'c4', title: '', description: '', attachments: ['a.png'] });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c4')!.get('attachments')).toEqual(['a.png']);

        writeCardToDoc(doc, 'comments', { id: 'c5', title: '', description: '', attachments: [] });
        expect(doc.getMap<Y.Map<unknown>>('comments').get('c5')!.has('attachments')).toBe(false);
    });

    test('honours alternate mapName ("tasks" for stickies)', () => {
        const doc = new Y.Doc();
        writeCardToDoc(doc, 'tasks', { id: 'c3', title: '', description: '' });
        expect(doc.getMap('tasks').has('c3')).toBe(true);
        expect(doc.getMap('comments').has('c3')).toBe(false);
    });
});
