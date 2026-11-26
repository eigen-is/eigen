// The open thread is the host's ?chat=: while it names a chat, the open comment is the card that holds it, else the
// index row that keeps it, which opens as deleted. A chat waits for the host to be ready and for the rows, and then a
// chat that names neither reads as missing, so the host can drop it.
// A visitor without a login reads only the cards in the document, never the server's index rows or members.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import * as Y from 'yjs';
import type { CommentEntry } from '../../../../types/chat';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

const session: { user: { id: string; email: string } | null } = { user: { id: 'owner-1', email: 'ada@example.com' } };
const realAuthContextModule = await import('../../../../core/auth/auth-context');
mock.module('../../../../core/auth/auth-context', () => ({
    useAuth: () => session,
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

// A host whose ?chat= is `chat` and whose `ready` is `ready`, which a test changes as the host would.
async function mountBoard(options: { chat?: string; rows?: CommentEntry[]; ready?: boolean }) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    if (options.rows) queryClient.setQueryData(listKey, options.rows);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner-1', 'm1', 'board-1'), []);
    const doc = board();
    const seen: { lifecycle: ReturnType<typeof useCommentLifecycle> | null } = { lifecycle: null };
    function Harness({ ready }: { ready: boolean }) {
        seen.lifecycle = useCommentLifecycle({
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'board-1',
            chatFolderId: 'chat-1',
            mediaFolderId: null,
            doc,
            activeCardIds: new Set(['card-1']),
            chat: options.chat,
            mapName: 'tasks',
            ready,
        });
        return null;
    }
    const root = createRoot(document.createElement('div'));
    const render = (ready: boolean) =>
        act(async () => {
            root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, { ready })));
        });
    await render(options.ready ?? true);
    unmount = async () => act(() => root.unmount());
    const lifecycle = () => {
        if (!seen.lifecycle) throw new Error('not rendered');
        return seen.lifecycle;
    };
    return { lifecycle, setReady: render, queryClient };
}

test('a chat a card holds opens that card', async () => {
    const { lifecycle } = await mountBoard({ chat: 'kept.eigenchat', rows });
    expect(lifecycle().openCard?.id).toBe('card-1');
    expect(lifecycle().openEntry?.title).toBe('Kept');
    expect([lifecycle().openCardDeleted, lifecycle().chatMissing]).toEqual([false, false]);
});

test('a chat whose card is gone opens as deleted, with the title of its row', async () => {
    const { lifecycle } = await mountBoard({ chat: 'removed.eigenchat', rows });
    expect(lifecycle().openCard).toBeNull();
    expect(lifecycle().openEntry?.title).toBe('Ship it');
    expect([lifecycle().openCardDeleted, lifecycle().chatMissing]).toEqual([true, false]);
});

test('a chat waits for the host and the rows, and then a chat nothing names is missing', async () => {
    const { lifecycle, queryClient, setReady } = await mountBoard({ chat: 'unknown.eigenchat', ready: false });
    await act(async () => {
        queryClient.setQueryData(listKey, rows);
    });
    expect([lifecycle().openCard, lifecycle().openEntry, lifecycle().chatMissing]).toEqual([null, undefined, false]);
    await setReady(true);
    // React Query tells its observers a task later.
    for (let i = 0; i < 10; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
    expect(lifecycle().chatMissing).toBe(true);
});

test('no chat opens nothing and misses nothing', async () => {
    const { lifecycle } = await mountBoard({ rows });
    expect([lifecycle().openCard, lifecycle().openEntry, lifecycle().chatMissing]).toEqual([null, undefined, false]);
});

test('a visitor lands on a card by its chat name and asks for no index row or member', async () => {
    session.user = null;
    fetchSpy.mockClear();
    try {
        const { lifecycle } = await mountBoard({ chat: 'kept.eigenchat' });
        expect(lifecycle().openCard?.id).toBe('card-1');
        expect(lifecycle().allComments).toEqual([]);
        expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
        session.user = { id: 'owner-1', email: 'ada@example.com' };
    }
});

test('a signed-in reader still reads the index rows and the members', async () => {
    fetchSpy.mockClear();
    await mountBoard({});
    const asked = fetchSpy.mock.calls.map(
        ([input]) => new URL(String(input instanceof Request ? input.url : input)).pathname,
    );
    expect(asked.some((pathname) => pathname.endsWith('/board-1/comments'))).toBe(true);
});
