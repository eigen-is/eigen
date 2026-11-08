// One comment thread stays mounted when its dialog moves to another card, and what waits to be sent belongs to the
// thread it was typed in.
import { afterAll, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const room = {
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
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: null }), useIsGuest: () => false }));
mock.module('@workspace/lib/chat', () => ({ ...realChat, useChatRoom: () => room }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useMediaResolver: () => ({ resolveChatId: (chatName: string) => `id-of-${chatName}` }),
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
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, 'For the first card');
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => root.render(thread('second')));
    expect(document.querySelector('textarea')?.value).toBe('');
    await act(async () => root.unmount());
});
