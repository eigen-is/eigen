import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { readCards } from './use-comment-cards';

describe('readCards (BC for legacy stickies cards)', () => {
    test('preserves legacy creator/createdAt fields', () => {
        const doc = new Y.Doc();
        const tasks = doc.getMap<Y.Map<unknown>>('tasks');
        doc.transact(() => {
            const c = new Y.Map<unknown>();
            c.set('id', 'legacy-1');
            c.set('title', 'Legacy card');
            c.set('description', 'desc');
            c.set('color', '#ff0000');
            c.set('chatName', 'legacy.eigenchat');
            c.set('creator', 'alice@example.com');
            c.set('createdAt', 1700000000000);
            tasks.set('legacy-1', c);
        });

        const result = readCards(tasks);
        expect(result['legacy-1']).toEqual({
            id: 'legacy-1',
            title: 'Legacy card',
            description: 'desc',
            color: '#ff0000',
            chatName: 'legacy.eigenchat',
            creator: 'alice@example.com',
            createdAt: 1700000000000,
        });
    });

    test('new cards have creator/createdAt undefined', () => {
        const doc = new Y.Doc();
        const tasks = doc.getMap<Y.Map<unknown>>('tasks');
        doc.transact(() => {
            const c = new Y.Map<unknown>();
            c.set('id', 'new-1');
            c.set('title', 'New card');
            c.set('description', '');
            c.set('color', '#00ff00');
            c.set('chatName', 'new.eigenchat');
            tasks.set('new-1', c);
        });

        const result = readCards(tasks);
        expect(result['new-1'].creator).toBeUndefined();
        expect(result['new-1'].createdAt).toBeUndefined();
        expect(result['new-1'].title).toBe('New card');
    });

    test('mixed legacy + new cards both project correctly', () => {
        const doc = new Y.Doc();
        const tasks = doc.getMap<Y.Map<unknown>>('tasks');
        doc.transact(() => {
            const legacy = new Y.Map<unknown>();
            legacy.set('id', 'legacy');
            legacy.set('title', 'Legacy');
            legacy.set('description', '');
            legacy.set('creator', 'old@example.com');
            legacy.set('createdAt', 1700000000000);
            legacy.set('chatName', 'legacy.eigenchat');
            tasks.set('legacy', legacy);

            const fresh = new Y.Map<unknown>();
            fresh.set('id', 'fresh');
            fresh.set('title', 'Fresh');
            fresh.set('description', '');
            fresh.set('chatName', 'fresh.eigenchat');
            tasks.set('fresh', fresh);
        });

        const result = readCards(tasks);
        expect(result['legacy'].creator).toBe('old@example.com');
        expect(result['fresh'].creator).toBeUndefined();
    });
});
