// A message's own actions, such as Edit and Delete, sit in a bar at its top right. A mouse user sees the bar on hover
// only, and until then a click there lands on the message below it. Tab reaches the bar's buttons and shows them.
import { afterAll, expect, mock, test } from 'bun:test';
import type { ChatMessage } from '@workspace/lib/types/chat';
import { installHappyDom } from '../../happy-dom';
import { expectKeyboardReveal } from '../../hover-reveal';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    useResolvedUser: ({ email }: { email?: string }) => ({
        displayName: email ?? '',
        resolvedEmail: email,
        avatarSrc: undefined,
        isLoading: false,
    }),
}));
// The list's file actions read the session.
const session = { user: { id: 'me', email: 'me@example.com' } };
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
afterAll(() => {
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('@workspace/lib/auth', () => realAuth);
});

const { act, createElement, useState } = await import('react');
const { ChatMessageList } = await import('../../../components/chat/chat-message-list');
const { PreviewContext } = await import('../../../components/preview-provider/preview-context');

// The list's file actions read the quick-look context; nothing here opens a preview.
const NO_PREVIEW = { openPreview: () => {}, updatePreview: () => {}, closePreview: () => {}, isPreviewOpen: false };

const MINE: ChatMessage = {
    id: 'm1',
    authorEmail: 'me@example.com',
    type: 'message',
    content: 'Hello',
    attachments: null,
    whisperTo: null,
    replyTo: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-11-02T09:00:00Z'),
};

test("a message's Edit and Delete show on hover only for a mouse, and Tab reaches and shows them", async () => {
    await renderInDocument(
        createElement(
            PreviewContext.Provider,
            { value: NO_PREVIEW },
            createElement(ChatMessageList, {
                messages: [MINE],
                isLoading: false,
                currentUserEmail: 'me@example.com',
                onEditMessage: () => {},
                onDeleteMessage: () => {},
            }),
        ),
    );
    const actions = ['Edit', 'Delete'].map((name) => document.querySelector(`button[aria-label="${name}"]`));
    expect(actions.every(Boolean)).toBe(true);
    for (const button of actions) if (button) expectKeyboardReveal(button);
});

// On touch a long press leaves the focus in the composer, so the menu opens from there. Edit focuses its own box, and
// the closing menu must not give the focus back to the composer: the box would lose it and close unchanged.
test('Edit from the menu keeps the focus in the edit box', async () => {
    function Chat() {
        const [editing, setEditing] = useState<string | null>(null);
        return createElement(
            'div',
            null,
            createElement(
                PreviewContext.Provider,
                { value: NO_PREVIEW },
                createElement(ChatMessageList, {
                    messages: [MINE],
                    isLoading: false,
                    currentUserEmail: 'me@example.com',
                    editingMessageId: editing,
                    onEditMessage: (message: ChatMessage) => setEditing(message.id),
                    onSaveEdit: () => setEditing(null),
                    onCancelEdit: () => setEditing(null),
                    onDeleteMessage: () => {},
                }),
            ),
            createElement('textarea', { 'data-composer': '' }),
        );
    }
    const { unmount } = await renderInDocument(createElement(Chat));
    const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    document.querySelector<HTMLElement>('[data-composer]')?.focus();
    const text = [...document.querySelectorAll('p, span, div')].find((el) => el.textContent === 'Hello');
    await act(async () => {
        text?.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
        );
    });
    await settle();
    const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (row) => row.textContent?.trim() === 'Edit',
    );
    await act(async () => edit?.click());
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const box = document.querySelector('textarea:not([data-composer])');
    expect(box).not.toBeNull();
    expect(document.activeElement).toBe(box);
    await unmount();
});
