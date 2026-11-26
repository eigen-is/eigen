// The open thread is the host's ?chat=: while it names a chat, the open comment is the card that holds it, else the
// index row that keeps it, which opens as deleted. Every open of a card with a chat goes through the host, which writes
// ?chat=, and close and delete ask the host to clear it. A chat nothing names is reported once, so the host can drop
// it. Only a ?card= landing, which names no chat, opens in the lifecycle's own state.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import * as Y from 'yjs';
import type { CommentEntry } from '../../../../types/chat';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => ({ user: { id: 'owner-1', email: 'ada@example.com' } }),
}));
afterAll(() => {
    mock.module('../../../../core/auth/auth-context', () => realAuthContextModule);
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { commentKeys } = await import('../../../../core/chat/hooks/keys');
const { driveKeys } = await import('../../../../core/drive/hooks/keys');
const { useCommentLifecycle } = await import('../../../../core/comments/hooks/use-comment-lifecycle');

const entry = (chatName: string, title: string | null): CommentEntry => ({
    chatName,
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    lastAuthorEmail: null,
    lastActivityAt: null,
    messageCount: 2,
    createdAt: new Date(0),
    assignee: null,
    title,
});
const rows = [entry('kept.eigenchat', 'Kept'), entry('removed.eigenchat', 'Ship it')];
const listKey = commentKeys.list('owner-1', 'm1', 'board-1');

// A board that holds a card with a thread. The card of `removed.eigenchat` was deleted from it, and its index row stayed.
function board(): Y.Doc {
    const doc = new Y.Doc();
    const card = new Y.Map<unknown>();
    card.set('id', 'card-1');
    card.set('title', 'Kept');
    card.set('description', '');
    card.set('chatName', 'kept.eigenchat');
    doc.getMap('tasks').set('card-1', card);
    return doc;
}

// A comments fetch that never answers, so a test sets the rows itself.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }),
);
afterAll(() => fetchSpy.mockRestore());

let unmount = async () => {};
afterEach(() => unmount());

// A host whose ?chat= is `chat`, which a test changes as the host's navigate would.
async function mountBoard(options: { chat?: string; initialCardId?: string; rows?: CommentEntry[] }) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    if (options.rows) queryClient.setQueryData(listKey, options.rows);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner-1', 'm1', 'board-1'), []);
    const onOpenChat = mock((_chatName: string) => {});
    const onCloseChat = mock(() => {});
    const onClearChat = mock(() => {});
    const onCardNotFound = mock(() => {});
    const doc = board();
    const seen: { lifecycle: ReturnType<typeof useCommentLifecycle> | null } = { lifecycle: null };
    function Harness({ chat }: { chat: string | undefined }) {
        seen.lifecycle = useCommentLifecycle({
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'board-1',
            chatFolderId: 'chat-1',
            mediaFolderId: null,
            doc,
            activeCardIds: new Set(['card-1']),
            chat,
            onOpenChat,
            onCloseChat,
            onClearChat,
            mapName: 'tasks',
            ready: true,
            initialCardId: options.initialCardId,
            onCardNotFound,
        });
        return null;
    }
    const root = createRoot(document.createElement('div'));
    const render = (chat: string | undefined) =>
        act(async () => {
            root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, { chat })));
        });
    await render(options.chat);
    unmount = async () => act(() => root.unmount());
    const lifecycle = () => {
        if (!seen.lifecycle) throw new Error('not rendered');
        return seen.lifecycle;
    };
    return { lifecycle, setChat: render, onOpenChat, onCloseChat, onClearChat, onCardNotFound, queryClient, doc };
}

test('a chat a card holds opens that card', async () => {
    const { lifecycle, onClearChat } = await mountBoard({ chat: 'kept.eigenchat', rows });
    expect(lifecycle().openCard?.id).toBe('card-1');
    expect(lifecycle().openEntry?.title).toBe('Kept');
    expect(lifecycle().openCardDeleted).toBe(false);
    expect(onClearChat).not.toHaveBeenCalled();
});

test('a chat whose card is gone opens as deleted, with the title of its row', async () => {
    const { lifecycle, onClearChat } = await mountBoard({ chat: 'removed.eigenchat', rows });
    expect(lifecycle().openCard).toBeNull();
    expect(lifecycle().openEntry?.title).toBe('Ship it');
    expect(lifecycle().openCardDeleted).toBe(true);
    expect(onClearChat).not.toHaveBeenCalled();
});

test('a chat waits for the rows, then a chat nothing names is reported once', async () => {
    const { lifecycle, onClearChat, queryClient, setChat } = await mountBoard({ chat: 'unknown.eigenchat' });
    expect(lifecycle().openCard).toBeNull();
    expect(lifecycle().openEntry).toBeUndefined();
    expect(onClearChat).not.toHaveBeenCalled();
    await act(async () => {
        queryClient.setQueryData(listKey, rows);
    });
    // React Query tells its observers a task later, and the render that follows runs the check.
    for (let i = 0; i < 10; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
    expect(onClearChat).toHaveBeenCalledTimes(1);
    await setChat('unknown.eigenchat');
    expect(onClearChat).toHaveBeenCalledTimes(1);
});

test('opening a card with a chat asks the host to write it, and opens nothing of its own', async () => {
    const { lifecycle, onOpenChat, setChat } = await mountBoard({ rows });
    await act(async () => lifecycle().setOpenCardId('card-1'));
    expect(onOpenChat.mock.calls).toEqual([['kept.eigenchat']]);
    expect(lifecycle().openCard).toBeNull();

    await setChat('kept.eigenchat');
    expect(lifecycle().openCard?.id).toBe('card-1');
});

test('closing a chat asks the host to clear it, and a delete asks it to drop it', async () => {
    const { lifecycle, onCloseChat, onClearChat } = await mountBoard({ chat: 'kept.eigenchat', rows });
    await act(async () => lifecycle().setOpenCardId(null));
    expect(onCloseChat).toHaveBeenCalledTimes(1);
    await act(async () => lifecycle().closeDeletedCard());
    expect(onClearChat).toHaveBeenCalledTimes(1);
    expect(onCloseChat).toHaveBeenCalledTimes(1);
});

test('a search hit or an activity row writes the chat of a live card and of one whose card is gone', async () => {
    const { lifecycle, onOpenChat } = await mountBoard({ rows });
    await act(async () => {
        expect(lifecycle().openChat('kept.eigenchat')).toBe(true);
        expect(lifecycle().openChat('removed.eigenchat')).toBe(true);
        expect(lifecycle().openChat('unknown.eigenchat')).toBe(false);
    });
    expect(onOpenChat.mock.calls).toEqual([['kept.eigenchat'], ['removed.eigenchat']]);
});

test("a host's own openCard opens a live card it finds, and the host's chat one whose card is gone", async () => {
    const { lifecycle, onOpenChat } = await mountBoard({ rows });
    const openCard = mock((_cardId: string) => {});
    await act(async () => {
        expect(lifecycle().openChat('kept.eigenchat', openCard)).toBe(true);
        expect(lifecycle().openChat('removed.eigenchat', openCard)).toBe(true);
    });
    expect(openCard.mock.calls).toEqual([['card-1']]);
    expect(onOpenChat.mock.calls).toEqual([['removed.eigenchat']]);
});

test("the menu's Edit writes the chat and opens the card in edit mode", async () => {
    const { lifecycle, onOpenChat, setChat } = await mountBoard({ rows });
    await act(async () => lifecycle().openCardForEdit('card-1'));
    expect(onOpenChat.mock.calls).toEqual([['kept.eigenchat']]);
    await setChat('kept.eigenchat');
    expect(lifecycle().openCard?.id).toBe('card-1');
    expect(lifecycle().openCardEditing).toBe(true);
});

test('a card link opens its card before the rows arrive, and reports an id no card holds', async () => {
    const live = await mountBoard({ initialCardId: 'card-1' });
    expect(live.lifecycle().openCard?.id).toBe('card-1');
    expect(live.onOpenChat).not.toHaveBeenCalled();
    await unmount();

    const unknown = await mountBoard({ initialCardId: 'card-9' });
    expect(unknown.onCardNotFound).toHaveBeenCalledTimes(1);
});
