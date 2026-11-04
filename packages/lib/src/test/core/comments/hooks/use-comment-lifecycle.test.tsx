// One rule opens a comment wherever it is reached, in every host. A landing, a search hit or an activity row that names
// a thread whose card is gone from the map, such as a sticky deleted from its board, opens the comment as deleted, with
// the title its index row keeps. A name that neither a card nor a row knows is reported, so the host can drop it.
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

// A board that holds one card. The card of `removed.eigenchat` was deleted from it, and its index row stayed.
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

async function mountBoard(options: { initialChatName?: string; initialCardId?: string; rows?: CommentEntry[] }) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    if (options.rows) queryClient.setQueryData(listKey, options.rows);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner-1', 'm1', 'board-1'), []);
    const onChatNotFound = mock(() => {});
    const onCardNotFound = mock(() => {});
    const doc = board();
    const seen: { lifecycle: ReturnType<typeof useCommentLifecycle> | null } = { lifecycle: null };
    function Harness() {
        seen.lifecycle = useCommentLifecycle({
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'board-1',
            chatFolderId: 'chat-1',
            mediaFolderId: null,
            doc,
            activeCardIds: new Set(['card-1']),
            initialChatName: options.initialChatName,
            mapName: 'tasks',
            ready: true,
            onChatNotFound,
            initialCardId: options.initialCardId,
            onCardNotFound,
        });
        return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)));
    });
    unmount = async () => act(() => root.unmount());
    const lifecycle = () => {
        if (!seen.lifecycle) throw new Error('not rendered');
        return seen.lifecycle;
    };
    return { lifecycle, onChatNotFound, onCardNotFound, queryClient, doc };
}

test('a landing on a comment whose card is gone opens it as deleted, with the title of its row', async () => {
    const { lifecycle, onChatNotFound } = await mountBoard({ initialChatName: 'removed.eigenchat', rows });
    expect(lifecycle().openCard?.title).toBe('Ship it');
    expect(lifecycle().openEntry?.chatName).toBe('removed.eigenchat');
    expect(lifecycle().openCardDeleted).toBe(true);
    expect(onChatNotFound).not.toHaveBeenCalled();
});

test('a landing waits for the rows, then reports a name nothing knows', async () => {
    const { lifecycle, onChatNotFound, queryClient } = await mountBoard({ initialChatName: 'unknown.eigenchat' });
    expect(onChatNotFound).not.toHaveBeenCalled();
    await act(async () => {
        queryClient.setQueryData(listKey, rows);
    });
    // React Query tells its observers a task later, and the render that follows runs the landing.
    for (let i = 0; i < 10; i++) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
    expect(onChatNotFound).toHaveBeenCalledTimes(1);
    expect(lifecycle().openCard).toBeNull();
});

test('a search hit or an activity row opens a live card live, and one whose card is gone as deleted', async () => {
    const { lifecycle } = await mountBoard({ rows });
    await act(async () => {
        expect(lifecycle().openChat('kept.eigenchat')).toBe(true);
    });
    expect(lifecycle().openCard?.id).toBe('card-1');
    expect(lifecycle().openCardDeleted).toBe(false);

    await act(async () => {
        expect(lifecycle().openChat('removed.eigenchat')).toBe(true);
    });
    expect(lifecycle().openCard?.title).toBe('Ship it');
    expect(lifecycle().openCardDeleted).toBe(true);

    await act(async () => {
        expect(lifecycle().openChat('unknown.eigenchat')).toBe(false);
    });
    expect(lifecycle().openCard?.title).toBe('Ship it');
});

test('a live card opened by its chat name closes when it is deleted, as one opened by its id does', async () => {
    const { lifecycle, doc } = await mountBoard({ rows });
    await act(async () => {
        expect(lifecycle().openChat('kept.eigenchat')).toBe(true);
    });
    expect(lifecycle().openCard?.id).toBe('card-1');
    await act(async () => {
        doc.getMap('tasks').delete('card-1');
    });
    expect(lifecycle().openCard).toBeNull();
    expect(lifecycle().openCardDeleted).toBe(false);
});

test('a card link opens its card before the rows arrive, and reports an id no card holds', async () => {
    const live = await mountBoard({ initialCardId: 'card-1' });
    expect(live.lifecycle().openCard?.id).toBe('card-1');
    await unmount();

    const unknown = await mountBoard({ initialCardId: 'card-9' });
    expect(unknown.onCardNotFound).toHaveBeenCalledTimes(1);
});
