// Chat's list is its sidebar: personal chats first, team chats under their own heading, an unread chat
// marked. The index opens the first chat, or offers to create one when there is none. A chat the viewer
// can't read asks for access, and one they can shows its messages and sends what they type.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { ChatMessage } from '@workspace/lib/types/chat';
import type { DrivePath } from '@workspace/lib/types/drive';
import { DRIVE_MIME_CHAT } from '@workspace/lib/types/drive';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

// A desktop window, where the sidebar shows its labels.
installHappyDom().happyDOM.setViewport({ width: 1440, height: 900 });

const chat = (id: string, name: string, ownerId = 'me@test.eigen.is'): DrivePath =>
    drivePath({ id, name, ownerId, type: 'chat', mimeType: DRIVE_MIME_CHAT });
const general = chat('c1', 'General.eigenchat');
const random = chat('c2', 'Random.eigenchat');
const design = chat('c3', 'Design crit.eigenchat', 'team-1');

// The app's data, stubbed: one object per hook, so the effects that depend on them settle.
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const guest = { value: false };
const sections: {
    personal: DrivePath[];
    teams: { id: string; name: string; chats: DrivePath[] }[];
    isLoading: boolean;
} = { personal: [], teams: [], isLoading: false };
const allChats: { chats: DrivePath[]; isLoading: boolean } = { chats: [], isLoading: false };
const unread = new Set<string>();
const permissions: { data: { canRead: boolean; canWrite: boolean } | undefined; isLoading: boolean } = {
    data: undefined,
    isLoading: false,
};
const message = (id: string, content: string): ChatMessage => ({
    id,
    authorEmail: 'ada@test.eigen.is',
    type: 'message',
    content,
    attachments: null,
    whisperTo: null,
    replyTo: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2026-10-27T09:00:00Z'),
});
const sent: string[] = [];
const room = {
    messages: [message('m1', 'Morning all'), message('m2', 'Lunch at noon?')],
    isLoading: false,
    chatName: 'General',
    chatPath: general,
    roomMembers: [],
    readOnly: false,
    disabled: false,
    currentUserEmail: session.user.email,
    mediaFolderId: undefined,
    handleSendMessage: async (content: string) => {
        sent.push(content);
    },
    handleEditMessage: async () => {},
    handleDeleteMessage: async () => {},
    hasOlderMessages: false,
    isFetchingOlderMessages: false,
    fetchOlderMessages: async () => {},
    driveAttachments: [],
    addDriveAttachments: () => {},
    removeDriveAttachment: () => {},
};

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realChat = { ...(await import('@workspace/lib/chat')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => guest.value }));
mock.module('@workspace/lib/chat', () => ({
    ...realChat,
    useChatSections: () => sections,
    useAllChats: () => allChats,
    useUnreadChatIds: () => unread,
    useChatRoom: () => room,
}));
mock.module('@workspace/lib/drive', () => ({ ...realDrive, useCheckPermissions: () => permissions }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/chat', () => realChat);
    mock.module('@workspace/lib/drive', () => realDrive);
});

const { act, createElement } = await import('react');
const { createMemoryHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { UploadProvider } = await import('@workspace/ui/components/upload-provider');
const { routeTree } = await import('../../routeTree.gen');

const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: { ...session.user, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    login: async () => ({ success: true }),
    logout: async () => {},
};

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    guest.value = false;
    sections.personal = [general, random];
    sections.teams = [{ id: 'team-1', name: 'Design', chats: [design] }];
    sections.isLoading = false;
    allChats.chats = [general, random, design];
    allChats.isLoading = false;
    unread.clear();
    permissions.data = { canRead: true, canWrite: true };
    permissions.isLoading = false;
    sent.length = 0;
});

async function open(url: string) {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [url] }),
        context: { auth },
    });
    await router.load();
    // A message's attachments open through the providers every app mounts around its routes.
    const rendered = await renderInDocument(
        createElement(
            UploadProvider,
            null,
            createElement(PreviewProvider, null, createElement(RouterProvider, { router })),
        ),
    );
    unmount = rendered.unmount;
    return {
        text: () => rendered.container.textContent ?? '',
        path: () => decodeURIComponent(router.state.location.pathname),
    };
}

// The sidebar's chat links in order, each as its label and target, with whether it wears the unread dot.
const chatLinks = () =>
    [...document.querySelectorAll('a[href^="/"]')]
        .filter((a) => a.querySelector('.lucide-message-square'))
        .map((a) => [a.textContent, a.getAttribute('href'), !!a.querySelector('.rounded-full.bg-destructive')]);
const buttonTexts = () => [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());

test('the sidebar lists personal chats first, then team chats under Team chats, without the extension', async () => {
    const page = await open('/me@test.eigen.is/default/c1');
    expect(chatLinks().map(([label, href]) => [label, href])).toEqual([
        ['General', '/me@test.eigen.is/default/c1'],
        ['Random', '/me@test.eigen.is/default/c2'],
        ['Design crit', '/team-1/default/c3'],
    ]);
    expect(page.text()).toContain('Team chats');
});

test('an unread chat wears the dot and a read one does not', async () => {
    unread.add('c2');
    await open('/me@test.eigen.is/default/c1');
    expect(chatLinks().map(([label, , dot]) => [label, dot])).toEqual([
        ['General', false],
        ['Random', true],
        ['Design crit', false],
    ]);
});

test('the index opens the first chat in sidebar order', async () => {
    const page = await open('/');
    expect(page.path()).toBe('/me@test.eigen.is/default/c1');
});

test('with no chats the index offers to create the first one', async () => {
    sections.personal = [];
    sections.teams = [];
    allChats.chats = [];
    const page = await open('/');
    expect(page.path()).toBe('/');
    expect(page.text()).toContain('No chats yet');
    expect(buttonTexts()).toContain('Create your first chat');
    expect(buttonTexts()).toContain('New chat');
});

test('a guest with no chats is offered no chat to create', async () => {
    guest.value = true;
    sections.personal = [];
    sections.teams = [];
    allChats.chats = [];
    const page = await open('/');
    expect(page.text()).toContain('No chats yet');
    expect(buttonTexts()).not.toContain('Create your first chat');
    expect(buttonTexts()).not.toContain('New chat');
});

test('while the chats load the index claims no empty list', async () => {
    allChats.chats = [];
    allChats.isLoading = true;
    const page = await open('/');
    expect(page.text()).not.toContain('No chats yet');
});

test("a chat the viewer can't read asks for access instead of showing it", async () => {
    permissions.data = { canRead: false, canWrite: false };
    const page = await open('/me@test.eigen.is/default/c1');
    expect(page.text()).toContain('You need access');
    expect(page.text()).not.toContain('Morning all');
});

test('a readable chat shows its messages, and Enter sends what was typed', async () => {
    const page = await open('/me@test.eigen.is/default/c1');
    expect(page.text()).toContain('Morning all');
    expect(page.text()).toContain('Lunch at noon?');

    const input = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Message General"]');
    if (!input) throw new Error('the chat has no message input');
    await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setValue?.call(input, '  On my way  ');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
    expect(sent).toEqual(['On my way']);
});
