import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { writeCardToDoc } from './use-create-comment-card';

describe('writeCardToDoc', () => {
    test('writes id/title/description/color/chatName into the named map', () => {
        const doc = new Y.Doc();
        writeCardToDoc(doc, 'comments', {
            id: 'c1',
            title: 't',
            description: 'd',
            color: '#ff0000',
            chatName: 'c1.eigenchat',
        });
        const y = doc.getMap<Y.Map<unknown>>('comments').get('c1')!;
        expect(y.get('id')).toBe('c1');
        expect(y.get('title')).toBe('t');
        expect(y.get('description')).toBe('d');
        expect(y.get('color')).toBe('#ff0000');
        expect(y.get('chatName')).toBe('c1.eigenchat');
    });

    test('omits color and chatName when not provided (new-card BC contract)', () => {
        const doc = new Y.Doc();
        writeCardToDoc(doc, 'comments', { id: 'c2', title: '', description: '' });
        const y = doc.getMap<Y.Map<unknown>>('comments').get('c2')!;
        expect(y.has('color')).toBe(false);
        expect(y.has('chatName')).toBe(false);
        expect(y.has('creator')).toBe(false);
        expect(y.has('createdAt')).toBe(false);
    });

    test('honours alternate mapName ("tasks" for stickies)', () => {
        const doc = new Y.Doc();
        writeCardToDoc(doc, 'tasks', { id: 'c3', title: '', description: '' });
        expect(doc.getMap('tasks').has('c3')).toBe(true);
        expect(doc.getMap('comments').has('c3')).toBe(false);
    });
});
