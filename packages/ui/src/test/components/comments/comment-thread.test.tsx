// One comment thread stays mounted when its dialog moves to another card, and what waits to be sent belongs to the
// thread it was typed in. Its messages sit under an Activity caption, a section of the card above them. Its reply box
// takes the focus as it shows, unless its host says not to, as a column does for a thread a link opened. A visitor
// without a login reads the card alone, with no loader and no reply box.
import { afterAll, expect, mock, test } from 'bun:test';
import type { ChatMessage } from '@workspace/lib/types/chat';
import { type } from '../../form-contract';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const room: { messages: ChatMessage[] } & Record<string, unknown> = {
    messages: [],
    isLoading: false,
    currentUserEmail: 'me@test.eigen.is',
    mediaFolderId: null,
    roomMembers: [],
    readOnly: false,
    disabled: false,
    handleSendMessage: async () => {},
    handleEditMessage: async () => {},
    handleDeleteMessage: async () => {},
    driveAttachments: [],
    addDriveAttachments: async () => {},
    removeDriveAttachment: () => {},
};
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realChat = { ...(await import('@workspace/lib/chat')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
// A visitor's listing has no chat folder, so no thread resolves and every one is known missing.
const listing = { hasChatFolder: true };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
mock.module('@workspace/lib/chat', () => ({ ...realChat, useChatRoom: () => room }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useMediaResolver: () => ({
        resolveChatId: (chatName: string) => (listing.hasChatFolder ? `id-of-${chatName}` : null),
        isChatMissing: () => !listing.hasChatFolder,
    }),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/chat', () => realChat);
    mock.module('@workspace/lib/drive', () => realDrive);
});

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PreviewProvider } = await import('../../../components/preview-provider');
const { UploadProvider } = await import('../../../components/upload-provider');
const { CommentThread } = await import('../../../components/comments/comment-thread');

const client = new QueryClient();

test('a draft stays behind when the thread moves to another card', async () => {
    const thread = (chatName: string) =>
        createElement(
            QueryClientProvider,
            { client },
            createElement(
                UploadProvider,
                null,
                createElement(
                    PreviewProvider,
                    null,
                    createElement(CommentThread, { ownerId: 'u1', mountId: 'm1', pathId: 'doc', chatName }),
                ),
            ),
        );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(thread('first')));

    const box = document.querySelector('textarea');
    if (!box) throw new Error('the thread drew no composer');
    await type(box, 'For the first card');

    await act(async () => root.render(thread('second')));
    expect(document.querySelector('textarea')?.value).toBe('');
    await act(async () => root.unmount());
});

test('the messages sit under an Activity caption, a section under the card', async () => {
    room.messages = [
        {
            id: 'm1',
            authorEmail: 'ada@test.eigen.is',
            type: 'message',
            content: 'Done',
            attachments: null,
            whisperTo: null,
            replyTo: null,
            editedAt: null,
            deletedAt: null,
            createdAt: new Date('2026-11-25T09:00:00Z'),
        },
    ];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(
            createElement(
                QueryClientProvider,
                { client },
                createElement(
                    UploadProvider,
                    null,
                    createElement(
                        PreviewProvider,
                        null,
                        createElement(CommentThread, {
                            ownerId: 'u1',
                            mountId: 'm1',
                            pathId: 'doc',
                            chatName: 'first',
                            lead: createElement('p', null, 'The card'),
                        }),
                    ),
                ),
            ),
        ),
    );
    const caption = container.querySelector('section > h3.eigen-section-label');
    expect(caption?.textContent).toBe('Activity');
    expect(caption?.closest('section')?.className).toContain('mt-6');
    room.messages = [];
    await act(async () => root.unmount());
});

test('the reply box takes the focus as the thread shows, unless the host turns that off', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const thread = (autoFocus?: boolean) =>
        createElement(
            QueryClientProvider,
            { client },
            createElement(
                UploadProvider,
                null,
                createElement(
                    PreviewProvider,
                    null,
                    createElement(CommentThread, {
                        ownerId: 'u1',
                        mountId: 'm1',
                        pathId: 'doc',
                        chatName: 'first',
                        autoFocus,
                    }),
                ),
            ),
        );
    await act(async () => root.render(thread(false)));
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA');
    await act(async () => root.unmount());

    const again = createRoot(container);
    await act(async () => again.render(thread()));
    expect(document.activeElement?.tagName).toBe('TEXTAREA');
    await act(async () => again.unmount());
});

// A peer's reply or the window coming back never pulls the focus from where the user is, such as a slide or a search
// field. The box takes it only as it opens and after the user's own send.
test('an incoming message and the window coming back leave the focus where it is', async () => {
    const container = document.createElement('div');
    const elsewhere = document.createElement('button');
    document.body.append(container, elsewhere);
    const root = createRoot(container);
    const thread = () =>
        createElement(
            QueryClientProvider,
            { client },
            createElement(
                UploadProvider,
                null,
                createElement(
                    PreviewProvider,
                    null,
                    createElement(CommentThread, { ownerId: 'u1', mountId: 'm1', pathId: 'doc', chatName: 'first' }),
                ),
            ),
        );
    await act(async () => root.render(thread()));
    expect(document.activeElement?.tagName).toBe('TEXTAREA');

    elsewhere.focus();
    room.messages = [
        {
            id: 'm1',
            authorEmail: 'ada@test.eigen.is',
            type: 'message',
            content: 'Done',
            attachments: null,
            whisperTo: null,
            replyTo: null,
            editedAt: null,
            deletedAt: null,
            createdAt: new Date('2026-11-25T09:00:00Z'),
        },
    ];
    await act(async () => root.render(thread()));
    expect(document.activeElement).toBe(elsewhere);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(document.activeElement).toBe(elsewhere);

    room.messages = [];
    await act(async () => root.unmount());
    elsewhere.remove();
});

test('a send keeps the focus in the reply box', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(
            createElement(
                QueryClientProvider,
                { client },
                createElement(
                    UploadProvider,
                    null,
                    createElement(
                        PreviewProvider,
                        null,
                        createElement(CommentThread, {
                            ownerId: 'u1',
                            mountId: 'm1',
                            pathId: 'doc',
                            chatName: 'first',
                            autoFocus: false,
                        }),
                    ),
                ),
            ),
        ),
    );
    const box = container.querySelector('textarea');
    if (!box) throw new Error('no reply box');
    box.focus();
    await type(box, 'On it');
    await act(async () => {
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(box.value).toBe('');
    expect(document.activeElement).toBe(box);
    await act(async () => root.unmount());
});

test('a visitor reads the card above the thread, with no loader and no reply box', async () => {
    listing.hasChatFolder = false;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(
            createElement(CommentThread, {
                ownerId: 'u1',
                mountId: 'm1',
                pathId: 'doc',
                chatName: 'first',
                lead: createElement('p', null, 'The card'),
            }),
        ),
    );
    expect(container.textContent).toBe('The card');
    expect(container.firstElementChild?.childElementCount).toBe(1);
    expect(container.querySelector('textarea')).toBeNull();
    await act(async () => root.unmount());
    listing.hasChatFolder = true;
});
