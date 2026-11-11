// A comment's card, as the pane and a board's drag overlay draw it: the card's own title and description, and from its
// index row the replies, the resolved mark and the assignee. Its attachments give the cover and the count.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const { drivePath } = await import('../../drive-path');
const cover = drivePath({
    id: 'cover-1',
    name: 'cover.png',
    type: 'file',
    mimeType: 'image/png',
    thumbnail: 'cover-thumb',
});
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useMediaResolver: () => ({ resolveMediaPath: (name: string) => (name === 'cover.png' ? cover : undefined) }),
}));
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: { email: 'me@example.com' } }) }));
mock.module('../../../components/comments/member-avatar', () => ({
    MemberAvatar: ({ email }: { email: string }) => <span data-testid="avatar">{email}</span>,
}));
afterAll(() => {
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act, createElement } = await import('react');
const { CommentNoteCard } = await import('../../../components/comments');

let unmount = async () => {};
afterEach(() => unmount());

const card: CommentCard = {
    id: 'card-1',
    title: 'The stored title',
    description: '<p>The description</p>',
    color: '#fde68a',
    attachments: ['cover.png', 'notes.pdf'],
};
const entry: CommentEntry = {
    chatName: 'thread-1.eigenchat',
    status: 'resolved',
    resolvedBy: null,
    resolvedAt: null,
    lastAuthorEmail: null,
    lastActivityAt: null,
    messageCount: 3,
    createdAt: new Date(0),
    assignee: 'ada@example.com',
    title: 'The stored title',
};

const text = () => document.body.textContent ?? '';

test('a card shows the title it is given, its description, its replies and its attachments', async () => {
    let container: HTMLElement;
    ({ unmount, container } = await renderInDocument(
        createElement(CommentNoteCard, { card, entry, title: 'Sheet2 · A title', unread: false }),
    ));
    expect(text()).toContain('Sheet2 · A title');
    expect(text()).not.toContain('The stored title');
    expect(text()).toContain('The description');
    expect(text()).toContain('3 replies');
    expect(container.querySelector('.lucide-paperclip')?.parentElement?.textContent?.trim()).toBe('2');
    expect(container.querySelector('img')?.getAttribute('src')).toContain('cover-thumb');
});

test('a resolved card shows the check, an assigned one the avatar, and an unread one the dot', async () => {
    const unreadCard = await renderInDocument(
        createElement(CommentNoteCard, { card, entry, title: 'T', unread: true }),
    );
    unmount = unreadCard.unmount;
    expect(unreadCard.container.querySelector('.lucide-check')).not.toBeNull();
    expect(unreadCard.container.querySelector('.bg-destructive')).not.toBeNull();
    expect(unreadCard.container.querySelector('[data-testid="avatar"]')?.textContent).toBe('ada@example.com');
});

test('a card with no index row yet shows none of what the row holds', async () => {
    let container: HTMLElement;
    ({ unmount, container } = await renderInDocument(
        createElement(CommentNoteCard, {
            card: { ...card, attachments: undefined },
            entry: undefined,
            title: 'T',
            unread: false,
        }),
    ));
    expect(text()).not.toContain('repl');
    expect(container.querySelector('.lucide-check')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.bg-destructive')).toBeNull();
    expect(container.querySelector('[data-testid="avatar"]')).toBeNull();
});

test('a deleted card shows its title and the line, and nothing of its content', async () => {
    ({ unmount } = await renderInDocument(
        createElement(CommentNoteCard, { card, entry, title: 'A title', unread: false, deleted: true }),
    ));
    expect(text()).toContain('A title');
    expect(text()).toContain('This comment was deleted');
    expect(text()).not.toContain('The description');
    expect(text()).not.toContain('3 replies');
});

test('the caller gets the click and the right-click, and sets the width', async () => {
    const onClick = mock(() => {});
    const onContextMenu = mock(() => {});
    let container: HTMLElement;
    ({ unmount, container } = await renderInDocument(
        createElement(CommentNoteCard, {
            card,
            entry,
            title: 'A title',
            unread: false,
            onClick,
            onContextMenu,
            className: 'w-[254px]',
        }),
    ));
    const frame = container.querySelector<HTMLElement>('.w-\\[254px\\]');
    if (!frame) throw new Error('no frame with the width');
    await act(async () => {
        frame.click();
        frame.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
});
