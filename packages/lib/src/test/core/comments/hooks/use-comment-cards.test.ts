import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { getItemMapRoot } from '../../../../core/collab/yjs-utils';
import { readCards, useCommentCards } from '../../../../core/comments/hooks/use-comment-cards';
import { countTaskItems } from '../../../../core/html';
import { sanitizeCommentCardHtml } from '../../../../core/html-dom';
import type { CommentCard } from '../../../../types/comments';
import type { AttachmentReference } from '../../../../types/drive-reference';
import { installHappyDom } from '../../../happy-dom';

// readCards sanitizes each card's description: it reaches us verbatim from a hostile peer's Y.Doc write
// and is rendered via dangerouslySetInnerHTML.
installHappyDom();

function cardWithDescription(html: string): CommentCard {
    const doc = new Y.Doc();
    const tasks = doc.getMap<unknown>('tasks');
    doc.transact(() => {
        const c = new Y.Map<unknown>();
        c.set('id', 'c1');
        c.set('title', 'Card');
        c.set('description', html);
        tasks.set('c1', c);
    });
    return readCards(tasks)['c1'];
}

describe('readCards', () => {
    test('reads every field a card stores', () => {
        const doc = new Y.Doc();
        const tasks = doc.getMap<unknown>('tasks');
        doc.transact(() => {
            const c = new Y.Map<unknown>();
            c.set('id', 'c1');
            c.set('title', 'A card');
            c.set('description', 'desc');
            c.set('color', '#ff0000');
            c.set('chatName', 'c1.eigenchat');
            c.set('creator', 'alice@example.com');
            c.set('createdAt', 1700000000000);
            tasks.set('c1', c);
        });

        const result = readCards(tasks);
        expect(result['c1']).toEqual({
            id: 'c1',
            title: 'A card',
            description: 'desc',
            color: '#ff0000',
            chatName: 'c1.eigenchat',
            creator: 'alice@example.com',
            createdAt: 1700000000000,
        });
    });

    test('a card may lack its creator and createdAt', () => {
        const doc = new Y.Doc();
        const tasks = doc.getMap<unknown>('tasks');
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
        const tasks = doc.getMap<unknown>('tasks');
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
            dirtyElements.set('attachments', [
                null,
                42,
                'ok.png',
                { id: 'no-type', name: 'x' },
                { ...reference, name: 7 },
                { ...reference, mimeType: 7 },
            ]);
            tasks.set('a3', dirtyElements);
        });

        const result = readCards(tasks);
        expect(result['a1'].attachments).toEqual(['photo.png', reference]);
        expect(result['a2'].attachments).toBeUndefined();
        expect(result['a3'].attachments).toEqual(['ok.png']);
    });

    test("skips a peer's scalar entry instead of throwing on it", () => {
        const doc = new Y.Doc();
        const tasks = doc.getMap<unknown>('tasks');
        doc.transact(() => {
            const card = new Y.Map<unknown>();
            card.set('id', 'ok');
            card.set('title', 'Fine');
            tasks.set('ok', card);
            tasks.set('scalar', 'not-a-card');
        });

        expect(Object.keys(readCards(getItemMapRoot(doc, 'tasks')))).toEqual(['ok']);
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

    test('a stray label/div/input outside a task item unwraps to its children', () => {
        const card = cardWithDescription(
            '<label>hi</label><div>body</div><input type="text" autofocus onfocus="alert(1)">',
        );
        expect(card.description).not.toContain('<label>');
        expect(card.description).not.toContain('<div>');
        expect(card.description).not.toContain('<input');
        expect(card.description).not.toContain('onfocus');
        expect(card.description).toContain('hi');
        expect(card.description).toContain('body');
    });

    test('countTaskItems still counts done/total after readCards', () => {
        const card = cardWithDescription(
            '<ul data-type="taskList">' +
                '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"></label><div><p>A</p></div></li>' +
                '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"></label><div><p>B</p></div></li>' +
                '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"></label><div><p>C</p></div></li>' +
                '</ul>',
        );
        expect(countTaskItems(card.description)).toEqual({ checked: 2, total: 3 });
    });

    test('sanitizing is idempotent — the toggled innerHTML NoteCardDialog writes back is stable', () => {
        const dirty =
            '<p><strong>keep</strong> <a href="https://eigen.is">link</a></p>' +
            '<img src=x onerror="alert(1)"><script>alert(2)</script>' +
            '<ul data-type="taskList"><li data-checked="true" data-type="taskItem">' +
            '<label><input type="checkbox" checked="checked"></label><div><p>Done <img src=x onerror="alert(3)"></p></div>' +
            '</li></ul>';
        const once = sanitizeCommentCardHtml(dirty);
        expect(sanitizeCommentCardHtml(once)).toBe(once);
    });
});

describe('the canvas delete mark', () => {
    function docWithCard(deletedAt?: unknown): Y.Doc {
        const doc = new Y.Doc();
        doc.transact(() => {
            const card = new Y.Map<unknown>();
            card.set('id', 'c1');
            card.set('title', 'Card');
            if (deletedAt !== undefined) card.set('deletedAt', deletedAt);
            doc.getMap<unknown>('comments').set('c1', card);
        });
        return doc;
    }

    test('readCards carries the mark, and a value that is not a time reads as not deleted', () => {
        expect(readCards(docWithCard(1700000000000).getMap('comments'))['c1'].deletedAt).toBe(1700000000000);
        expect(readCards(docWithCard('yes').getMap('comments'))['c1'].deletedAt).toBeUndefined();
    });

    // useCommentCards reuses a card object whose fields are unchanged, so a mark it does not compare would never
    // reach the host.
    test('marking a card deleted hands the host a new card', async () => {
        const { act, createElement } = await import('react');
        const { createRoot } = await import('react-dom/client');
        const doc = docWithCard();
        const seen: CommentCard[] = [];
        function Harness() {
            const card = useCommentCards(doc, 'comments')['c1'];
            if (card) seen.push(card);
            return null;
        }
        const root = createRoot(document.createElement('div'));
        await act(async () => root.render(createElement(Harness)));
        await act(async () => {
            const card = doc.getMap('comments').get('c1');
            if (card instanceof Y.Map) card.set('deletedAt', 5);
        });
        expect(seen.at(-1)?.deletedAt).toBe(5);
        await act(async () => root.unmount());
    });
});
