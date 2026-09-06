import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import * as Y from 'yjs';
import { readCards } from '../../../../core/comments/hooks/use-comment-cards';
import type { CommentCard } from '../../../../types/comments';
import type { AttachmentReference } from '../../../../types/drive-reference';

// readCards sanitizes each card's description (it reaches us verbatim from a hostile peer's Y.Doc
// write and is rendered via dangerouslySetInnerHTML) — install happy-dom the way html-dom.test.ts does.
const window = new Window();
Object.assign(globalThis, { DOMParser: window.DOMParser, document: window.document, Node: window.Node });

function cardWithDescription(html: string): CommentCard {
    const doc = new Y.Doc();
    const tasks = doc.getMap<Y.Map<unknown>>('tasks');
    doc.transact(() => {
        const c = new Y.Map<unknown>();
        c.set('id', 'c1');
        c.set('title', 'Card');
        c.set('description', html);
        tasks.set('c1', c);
    });
    return readCards(tasks)['c1'];
}

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

    test('parses attachments and ignores malformed values', () => {
        const doc = new Y.Doc();
        const tasks = doc.getMap<Y.Map<unknown>>('tasks');
        const reference: AttachmentReference = {
            type: 'reference',
            ownerId: 'o1',
            mountId: 'm1',
            id: 'p1',
            name: 'Doc.eigendoc',
            driveType: 'doc',
            mimeType: 'application/eigendoc',
        };
        doc.transact(() => {
            const withAttachments = new Y.Map<unknown>();
            withAttachments.set('id', 'a1');
            withAttachments.set('title', 'Has attachments');
            withAttachments.set('description', '');
            withAttachments.set('attachments', ['photo.png', reference]);
            tasks.set('a1', withAttachments);

            const malformed = new Y.Map<unknown>();
            malformed.set('id', 'a2');
            malformed.set('title', 'Malformed');
            malformed.set('description', '');
            malformed.set('attachments', 'not-an-array');
            tasks.set('a2', malformed);

            const dirtyElements = new Y.Map<unknown>();
            dirtyElements.set('id', 'a3');
            dirtyElements.set('title', 'Dirty elements');
            dirtyElements.set('description', '');
            dirtyElements.set('attachments', [null, 42, 'ok.png']);
            tasks.set('a3', dirtyElements);
        });

        const result = readCards(tasks);
        expect(result['a1'].attachments).toEqual(['photo.png', reference]);
        expect(result['a2'].attachments).toBeUndefined();
        expect(result['a3'].attachments).toEqual(['ok.png']);
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

describe('readCards sanitizes hostile description HTML', () => {
    test('strips an <img onerror> handler and a <script> tag, keeps LightEditor markup', () => {
        const card = cardWithDescription(
            '<p><strong>bold</strong> <a href="https://eigen.is">link</a></p>' +
                '<img src=x onerror="alert(1)"><script>alert(2)</script>',
        );
        expect(card.description).not.toContain('onerror');
        expect(card.description).not.toContain('<img');
        expect(card.description).not.toContain('<script');
        expect(card.description).toContain('<strong>bold</strong>');
        expect(card.description).toContain(
            '<a target="_blank" rel="noopener noreferrer" href="https://eigen.is">link</a>',
        );
    });

    test('preserves task-list markup while dropping a payload smuggled inside a task item', () => {
        const card = cardWithDescription(
            '<ul data-type="taskList">' +
                '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Done</p></div></li>' +
                '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>Todo <img src=x onerror="alert(1)"></p></div></li>' +
                '</ul>',
        );
        expect(card.description).toContain('data-type="taskList"');
        expect(card.description).toContain('data-checked="true"');
        expect(card.description).toContain('data-checked="false"');
        expect(card.description).toContain('type="checkbox"');
        expect(card.description).toContain('<div><p>Done</p></div>');
        expect(card.description).not.toContain('onerror');
        expect(card.description).not.toContain('<img');
    });
});
