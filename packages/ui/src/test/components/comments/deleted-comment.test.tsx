// A deleted comment, one whose thread is gone or whose card the document no longer uses, shows its title greyed and
// the line "This comment was deleted", in the card dialog and in the pane. Nothing on it acts: no reply, resolve,
// assign or edit. A thread the chat folder doesn't list shows the loading line while the dialog decides.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
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
const { CardDialog } = await import('../../../components/cards/card-dialog');
const { CommentPanel } = await import('../../../components/comments/comment-panel');
const { CommentThread } = await import('../../../components/comments/comment-thread');
const { PreviewProvider } = await import('../../../components/preview-provider');

let unmount = async () => {};
afterEach(() => unmount());

const card: CommentCard = {
    id: 'card-1',
    title: 'Check this',
    description: '<p>The second paragraph</p>',
    color: '#fde68a',
    chatName: 'thread-1.eigenchat',
    creator: 'ada@example.com',
    createdAt: 1,
};
const entry: CommentEntry = {
    chatName: 'thread-1.eigenchat',
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    lastAuthorEmail: null,
    lastActivityAt: null,
    messageCount: 3,
    createdAt: new Date(0),
    assignee: 'ada@example.com',
    title: 'Check this',
};
const member = { email: 'ada@example.com', read: true, write: true };

const text = () => document.body.textContent ?? '';
const buttons = () =>
    [...document.querySelectorAll('button')].map((b) => b.textContent?.trim() || b.getAttribute('aria-label'));

function renderDialog(deleted: boolean, shown: CommentCard = card) {
    return renderInDocument(
        createElement(
            PreviewProvider,
            null,
            createElement(CardDialog, {
                open: true,
                onOpenChange: () => {},
                card: shown,
                entry,
                ownerId: 'owner-1',
                mountId: 'm1',
                pathId: 'doc-1',
                canWrite: true,
                deleted,
                isEditing: false,
                onEditingChange: () => {},
                members: [member],
                currentUserEmail: 'ada@example.com',
                onUpdate: () => {},
                onResolve: () => {},
                onAssign: () => {},
            }),
        ),
    );
}

test('the dialog of a deleted comment shows its title and the line, and nothing that acts', async () => {
    ({ unmount } = await renderDialog(true));
    expect(text()).toContain('Check this');
    expect(text()).toContain('This comment was deleted');
    // The description, the assignee, the reply box and every action are gone; only the close button is left.
    expect(text()).not.toContain('The second paragraph');
    expect(document.querySelector('textarea, [contenteditable="true"]')).toBeNull();
    expect(buttons()).toEqual(['Close']);
});

test('the dialog of a deleted comment without a title calls it a comment, as the pane does', async () => {
    ({ unmount } = await renderDialog(true, { ...card, title: '' }));
    expect(document.querySelector('[role="dialog"] p')?.textContent).toBe('Comment');
});

test('the dialog of a live comment keeps its actions', async () => {
    ({ unmount } = await renderDialog(false));
    expect(text()).not.toContain('This comment was deleted');
    expect(text()).toContain('The second paragraph');
    expect(buttons().length).toBeGreaterThan(1);
});

test('a thread the chat folder does not list shows the loading line and no reply box', async () => {
    ({ unmount } = await renderInDocument(
        createElement(CommentThread, {
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'doc-1',
            chatName: card.chatName ?? '',
        }),
    ));
    expect(document.querySelector('svg')).not.toBeNull();
    expect(document.querySelector('textarea, [contenteditable="true"]')).toBeNull();
});

test('the pane card of a re-anchored comment whose thread was swept shows the deleted state', async () => {
    const filter = {
        filter: DEFAULT_COMMENT_FILTER,
        setAssignee: () => {},
        toggleColor: () => {},
        setStatus: () => {},
        isActive: false,
        clear: () => {},
    };
    ({ unmount } = await renderInDocument(
        createElement(CommentPanel, {
            cards: { [card.id]: card },
            entries: [entry],
            activeCardIds: new Set([card.id]),
            anchorTexts: new Map([[card.id, 'Hello']]),
            isCardDeleted: () => true,
            pathId: 'doc-1',
            currentUserEmail: 'ada@example.com',
            filter,
        }),
    ));
    expect(text()).toContain('Hello');
    expect(text()).toContain('This comment was deleted');
    expect(text()).not.toContain('3 replies');
    expect(text()).not.toContain('The second paragraph');
});
