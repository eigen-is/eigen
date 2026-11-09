// A pane row reads the card's title, whatever the card is anchored to, and "Comment" when it has none. Only a host
// whose cards can sit somewhere the reader isn't looking, such as a sheet's other tabs, puts a prefix before it.
import { afterAll, expect, mock, test } from 'bun:test';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { CommentContextMenuItem } from '../../../components/comments/comment-menu-items';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { createElement } = await import('react');
const { DEFAULT_COMMENT_FILTER } = await import('@workspace/lib/comments');
const { useContextMenu } = await import('../../../components/context-menu');
const { CommentPanel } = await import('../../../components/comments/comment-panel');
const { PanelColumn } = await import('../../../components/comments/panel-column');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('../../drive-path');

const filter = {
    filter: DEFAULT_COMMENT_FILTER,
    setAssignee: () => {},
    toggleColor: () => {},
    setStatus: () => {},
    isActive: false,
    clear: () => {},
};
const titled: CommentCard = { id: 'titled', title: 'Check this', description: '' };
const untitled: CommentCard = { id: 'untitled', title: '', description: '' };
const cards = { titled, untitled };
const ids = new Set(['titled']);

function renderPanel(activeCardIds: ReadonlySet<string>, titlePrefixes?: ReadonlyMap<string, string>) {
    return renderInDocument(
        createElement(CommentPanel, {
            cards,
            entries: [],
            activeCardIds,
            titlePrefixes,
            isCardDeleted: () => false,
            pathId: 'doc-1',
            currentUserEmail: 'ada@example.com',
            filter,
        }),
    );
}

const rowTitle = () => document.querySelector('.line-clamp-2')?.textContent;

test('a row reads the title of its card', async () => {
    const { unmount } = await renderPanel(ids);
    expect(rowTitle()).toBe('Check this');
    await unmount();
});

test('a row without a title reads Comment', async () => {
    const { unmount } = await renderPanel(new Set(['untitled']));
    expect(rowTitle()).toBe('Comment');
    await unmount();
});

test('a prefix goes before the title, and only on the card it names', async () => {
    const prefixes = new Map([['titled', 'Sheet2']]);
    const named = await renderPanel(ids, prefixes);
    expect(rowTitle()).toBe('Sheet2 · Check this');
    await named.unmount();

    const other = await renderPanel(new Set(['untitled']), prefixes);
    expect(rowTitle()).toBe('Comment');
    await other.unmount();
});

test('a prefix goes before the Comment of a card without a title', async () => {
    const { unmount } = await renderPanel(new Set(['untitled']), new Map([['untitled', 'Sheet2']]));
    expect(rowTitle()).toBe('Sheet2 · Comment');
    await unmount();
});

test('the pane column hands its host prefixes to the rows', async () => {
    const path = drivePath({ id: 'doc-1', name: 'Budget', type: 'doc', mimeType: DRIVE_MIME_DOC });
    function Host() {
        const commentContextMenu = useContextMenu<CommentContextMenuItem>();
        return createElement(PanelColumn, {
            activePanel: 'comments',
            onClose: () => {},
            path,
            cards,
            entries: [],
            members: [],
            currentUserEmail: 'ada@example.com',
            filter,
            activeComments: { ids, titlePrefixes: new Map([['titled', 'Sheet2']]) },
            commentContextMenu,
            onOpenCard: () => {},
            onOpenChat: () => {},
        });
    }
    const { unmount } = await renderInDocument(createElement(Host));
    expect(rowTitle()).toBe('Sheet2 · Check this');
    await unmount();
});
