// A delete from the card's edit form or the comment menu asks first, in every host, and only then runs the host's delete
// and closes the open comment: a thread a link opened drops its ?chat= by replace.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import * as Y from 'yjs';
import type { CommentContextMenuItem } from '../../../components/comments/comment-menu-items';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// The delete the comment menu was last rendered with.
const seen: { menuDelete?: (cardId: string) => void } = {};

const realAuth = { ...(await import('@workspace/lib/auth')) };
const realContextMenu = { ...(await import('../../../components/comments/comment-context-menu')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: { id: 'owner-1', email: 'ada@example.com' } }),
}));
mock.module('../../../components/comments/comment-context-menu', () => ({
    CommentContextMenu: (props: { onDelete: (cardId: string) => void }) => {
        seen.menuDelete = props.onDelete;
        return null;
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('../../../components/comments/comment-context-menu', () => realContextMenu);
});

// A comments fetch that never answers, so the rows are what the test sets.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }),
);
afterAll(() => fetchSpy.mockRestore());

const { act, createElement } = await import('react');
const router = await import('@tanstack/react-router');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { commentKeys } = await import('@workspace/lib/chat');
const { driveKeys } = await import('@workspace/lib/drive');
const { useContextMenu } = await import('../../../components/context-menu');
const { CommentLifecycleDialogs } = await import('../../../components/comments/comment-lifecycle-dialogs');
const { useCommentHost } = await import('../../../components/comments/use-comment-host');

function addCard(doc: Y.Doc): void {
    const card = new Y.Map<unknown>();
    card.set('title', 'Ship it');
    card.set('description', '');
    card.set('chatName', 'ship.eigenchat');
    doc.getMap('tasks').set('card-1', card);
}

let unmount = async () => {};
afterEach(() => unmount());

// A board whose card's thread a link names.
async function mountBoard() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(commentKeys.list('owner-1', 'm1', 'board-1'), []);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner-1', 'm1', 'board-1'), []);
    const doc = new Y.Doc();
    addCard(doc);
    const onDelete = mock((_cardId: string) => {});
    const handle: { requestDelete?: (cardId: string) => void; openCard?: boolean } = {};
    function Harness() {
        const { chat } = router.useSearch({ strict: false });
        const { lifecycle } = useCommentHost({
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'board-1',
            chatFolderId: 'chat-1',
            mediaFolderId: null,
            doc,
            activeCardIds: new Set(['card-1']),
            panel: undefined,
            chat,
            card: undefined,
            listPanel: undefined,
            mapName: 'tasks',
            ready: true,
        });
        handle.requestDelete = lifecycle.requestDelete;
        handle.openCard = !!lifecycle.openCard;
        const commentContextMenu = useContextMenu<CommentContextMenuItem>();
        return createElement(CommentLifecycleDialogs, {
            lifecycle,
            canWrite: true,
            commentContextMenu,
            onDelete,
            noun: 'card',
        });
    }
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({
        getParentRoute: () => root,
        path: '/',
        validateSearch: (search: Record<string, unknown>): { chat?: string } =>
            typeof search.chat === 'string' ? { chat: search.chat } : {},
        component: Harness,
    });
    const history = router.createMemoryHistory({ initialEntries: ['/', '/?chat=ship.eigenchat'] });
    const memory = router.createRouter({ routeTree: root.addChildren([page]), history });
    await memory.load();
    ({ unmount } = await renderInDocument(
        createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(router.RouterProvider, { router: memory }),
        ),
    ));
    const chat = () => new URLSearchParams(history.location.search).get('chat');
    return { onDelete, handle, chat, index: () => history.location.state.__TSR_index };
}

// A navigate commits a tick later.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const confirmDialog = () => document.querySelector('[role="alertdialog"], [role="dialog"]');
const dialogButton = (name: string) => {
    const button = [...(confirmDialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === name);
    if (!button) throw new Error(`no ${name} button`);
    return button;
};

test('a delete asks first, then runs the delete and drops the open thread from the URL', async () => {
    const { onDelete, handle, chat, index } = await mountBoard();
    expect(handle.openCard).toBe(true);
    await act(async () => handle.requestDelete?.('card-1'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(confirmDialog()?.querySelector('h2')?.textContent).toBe('Delete card');
    expect(confirmDialog()?.querySelector('p')?.textContent).toBe('This deletes the card and its replies.');
    expect(dialogButton('Delete').getAttribute('data-variant')).toBe('destructive');

    await act(async () => dialogButton('Delete').click());
    await settle();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('card-1');
    expect(chat()).toBeNull();
    expect(index()).toBe(1);
    expect(confirmDialog()).toBeNull();
});

test('cancelling keeps the card and its thread, and the menu asks the same way', async () => {
    const { onDelete, chat } = await mountBoard();
    await act(async () => seen.menuDelete?.('card-1'));
    expect(confirmDialog()?.textContent).toContain('Delete card');

    await act(async () => dialogButton('Cancel').click());
    await settle();
    expect(onDelete).not.toHaveBeenCalled();
    expect(chat()).toBe('ship.eigenchat');
    expect(confirmDialog()).toBeNull();
});
