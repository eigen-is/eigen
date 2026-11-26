// The open thread is the page's ?chat=, so a link, a click and the comment menu's Edit all open the card dialog through
// the URL, and every close takes ?chat= out again: back after a click's push, a replace on a link. A delete and a chat
// that names nothing close it the same way.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { CommentEntry } from '@workspace/lib/types/chat';
import { DRIVE_MIME_STICKIES } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import type { CommentContextMenuItem } from '../../../components/comments/comment-menu-items';
import type { CommentLifecycleBundle } from '../../../components/comments/use-comment-host';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// The props the card dialog was last rendered with.
const seen: { open?: boolean; isEditing?: boolean; onOpenChange?: (open: boolean) => void } = {};

const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCardDialog = { ...(await import('../../../components/cards/card-dialog')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: { id: 'owner-1', email: 'ada@example.com' } }),
}));
mock.module('../../../components/cards/card-dialog', () => ({
    CardDialog: (props: { open: boolean; isEditing: boolean; onOpenChange: (open: boolean) => void }) => {
        seen.open = props.open;
        seen.isEditing = props.isEditing;
        seen.onOpenChange = props.onOpenChange;
        return null;
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('../../../components/cards/card-dialog', () => realCardDialog);
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
const { CommentCardDialog } = await import('../../../components/comments/comment-card-dialog');
const { CommentLifecycleDialogs } = await import('../../../components/comments/comment-lifecycle-dialogs');
const { useCommentHost } = await import('../../../components/comments/use-comment-host');

const path = drivePath({
    id: 'board-1',
    mountId: 'm1',
    name: 'Board',
    type: 'stickies',
    mimeType: DRIVE_MIME_STICKIES,
});

const row = (chatName: string): CommentEntry => ({
    chatName,
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    lastAuthorEmail: null,
    lastActivityAt: null,
    messageCount: 0,
    createdAt: new Date(0),
    assignee: null,
    title: 'Gone',
});

function addCard(doc: Y.Doc, id: string, chatName: string): void {
    const card = new Y.Map<unknown>();
    card.set('title', 'Ship it');
    card.set('description', '');
    card.set('chatName', chatName);
    doc.getMap('tasks').set(id, card);
}

let unmount = async () => {};
afterEach(() => unmount());

// A board at / whose route reads ?chat=, as every editor route does. Its second card's thread has no row yet.
async function openBoard(entries: string[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(commentKeys.list('owner-1', 'm1', 'board-1'), [
        row('ship.eigenchat'),
        row('gone.eigenchat'),
    ]);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner-1', 'm1', 'board-1'), []);
    const doc = new Y.Doc();
    addCard(doc, 'card-1', 'ship.eigenchat');
    addCard(doc, 'card-3', 'fresh.eigenchat');
    const onDelete = mock((_cardId: string) => {});
    const handle: { lifecycle?: CommentLifecycleBundle } = {};
    function Board() {
        const { lifecycle } = useCommentHost({
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'board-1',
            chatFolderId: 'chat-1',
            mediaFolderId: null,
            doc,
            activeCardIds: new Set(['card-1', 'card-3']),
            listPanel: undefined,
            mapName: 'tasks',
            ready: true,
        });
        handle.lifecycle = lifecycle;
        const commentContextMenu = useContextMenu<CommentContextMenuItem>();
        return createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(CommentCardDialog, { lifecycle, path, canWrite: true }),
            createElement(CommentLifecycleDialogs, { lifecycle, canWrite: true, commentContextMenu, onDelete }),
        );
    }
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({
        getParentRoute: () => root,
        path: '/',
        validateSearch: (search: Record<string, unknown>): { chat?: string } =>
            typeof search.chat === 'string' ? { chat: search.chat } : {},
        component: Board,
    });
    const history = router.createMemoryHistory({ initialEntries: entries });
    const memory = router.createRouter({ routeTree: root.addChildren([page]), history });
    await memory.load();
    const rendered = await renderInDocument(
        createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(router.RouterProvider, { router: memory }),
        ),
    );
    unmount = rendered.unmount;
    const lifecycle = () => {
        if (!handle.lifecycle) throw new Error('not rendered');
        return handle.lifecycle;
    };
    return {
        doc,
        lifecycle,
        onDelete,
        chat: () => new URLSearchParams(history.location.search).get('chat'),
        index: () => history.location.state.__TSR_index,
    };
}

async function run(action: () => void) {
    await act(async () => action());
    // A navigate commits a tick later, and a back on the history's next tick.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

const confirmButton = (name: string) => {
    const button = [...document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')].find(
        (b) => b.textContent === name,
    );
    if (!(button instanceof HTMLElement)) throw new Error(`no ${name} button`);
    return button;
};

test("a link's ?chat= opens the card, and closing it takes ?chat= out by replace", async () => {
    const board = await openBoard(['/', '/?chat=ship.eigenchat']);
    expect(seen.open).toBe(true);
    expect(board.lifecycle().openCard?.id).toBe('card-1');
    await run(() => seen.onOpenChange?.(false));
    expect(board.chat()).toBeNull();
    expect(board.index()).toBe(1);
    expect(seen.open).toBe(false);
});

test('a click writes ?chat= with a push, and closing goes back', async () => {
    const board = await openBoard(['/']);
    await run(() => board.lifecycle().setOpenCardId('card-1'));
    expect(board.chat()).toBe('ship.eigenchat');
    expect(board.index()).toBe(1);
    expect(seen.open).toBe(true);
    await run(() => seen.onOpenChange?.(false));
    expect(board.chat()).toBeNull();
    expect(board.index()).toBe(0);
    expect(seen.open).toBe(false);
});

test("the comment menu's Edit writes ?chat= and opens the card in edit mode", async () => {
    const board = await openBoard(['/']);
    await run(() => board.lifecycle().openCardForEdit('card-1'));
    expect(board.chat()).toBe('ship.eigenchat');
    expect(seen.open).toBe(true);
    expect(seen.isEditing).toBe(true);
});

test('a link to a comment whose card is gone opens it as deleted', async () => {
    const board = await openBoard(['/?chat=gone.eigenchat']);
    expect(seen.open).toBe(true);
    expect(board.lifecycle().openCardDeleted).toBe(true);
});

test('a ?chat= that names no comment is dropped by replace', async () => {
    const board = await openBoard(['/', '/?chat=unknown.eigenchat']);
    await run(() => {});
    expect(board.chat()).toBeNull();
    expect(board.index()).toBe(1);
    expect(seen.open).toBe(false);
});

test('a delete runs the host delete and closes the card as a close does: back over a click, a replace on a link', async () => {
    const board = await openBoard(['/']);
    await run(() => board.lifecycle().setOpenCardId('card-1'));
    await run(() => board.lifecycle().requestDelete('card-1'));
    await run(() => confirmButton('Delete').click());
    expect(board.onDelete).toHaveBeenCalledWith('card-1');
    expect(board.chat()).toBeNull();
    expect(board.index()).toBe(0);
    expect(seen.open).toBe(false);
    await unmount();

    const linked = await openBoard(['/', '/?chat=ship.eigenchat']);
    await run(() => linked.lifecycle().requestDelete('card-1'));
    await run(() => confirmButton('Delete').click());
    expect(linked.chat()).toBeNull();
    expect(linked.index()).toBe(1);
});

test('a delete of a card that is not open leaves the open one', async () => {
    const board = await openBoard(['/', '/?chat=ship.eigenchat']);
    await run(() => board.lifecycle().requestDelete('card-3'));
    await run(() => confirmButton('Delete').click());
    expect(board.onDelete).toHaveBeenCalledWith('card-3');
    expect(board.chat()).toBe('ship.eigenchat');
    expect(seen.open).toBe(true);
});

test("a peer's delete of a thread with no row yet closes it as a close does, back over the click", async () => {
    const board = await openBoard(['/']);
    await run(() => board.lifecycle().setOpenCardId('card-3'));
    expect(board.index()).toBe(1);
    await run(() => board.doc.getMap('tasks').delete('card-3'));
    expect(board.chat()).toBeNull();
    expect(board.index()).toBe(0);
    expect(seen.open).toBe(false);
});
