// The board opens a card in its own dialog, and the open thread is the route's ?chat=, as in every editor: a link, an
// activity row and a click on a card open it through the URL, and closing the dialog takes ?chat= out again. A copied
// card's ?card= opens the dialog without a thread in the URL, and closing it drops ?card= by replace.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { DRIVE_MIME_STICKIES } from '@workspace/lib/types/drive';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import type { ReactNode } from 'react';
import * as Y from 'yjs';

installHappyDom();

// The props the card dialog and the first column were last rendered with.
const seen: {
    open?: boolean;
    cardId?: string;
    onOpenChange?: (open: boolean) => void;
    onCardOpen?: (id: string) => void;
} = {};
let doc = new Y.Doc();

const { act, createElement } = await import('react');
const router = await import('@tanstack/react-router');
const { QueryClientProvider } = await import('@tanstack/react-query');
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCards = { ...(await import('@workspace/ui/components/cards')) };
const realLayout = { ...(await import('@workspace/ui/components/layout/app')) };
const realSearch = { ...(await import('@workspace/ui/components/search/doc-search-provider')) };
const Children = ({ children }: { children?: ReactNode }) => children;
const Nothing = () => null;
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: { id: 'u1', email: 'ann@example.com' } }),
}));
mock.module('@workspace/ui/components/cards', () => ({ ...realCards, CardFormDialog: Nothing }));
mock.module('@workspace/ui/components/layout/app', () => ({
    ...realLayout,
    CollabDocumentGate: Children,
    UnsyncedEditsGuard: Nothing,
    useLayout: () => ({ isMobile: false }),
}));
mock.module('@workspace/ui/components/search/doc-search-provider', () => ({
    ...realSearch,
    DocSearchProvider: Children,
}));
mock.module('../../../components/stickies/hooks/use-board', () => ({
    useBoard: () => ({
        board: { columns: { col: { id: 'col', title: 'To do', taskIds: ['card-1'] } }, columnOrder: ['col'] },
        isAddColumnDialogOpen: false,
        setIsAddColumnDialogOpen: () => {},
        handleAddColumn: () => {},
        deleteCardFromBoard: () => {},
        isSynced: true,
        offline: false,
        loaded: true,
        storageUnavailable: false,
        storageGone: false,
        unsyncedEdits: false,
        yjsDoc: doc,
        undoManager: null,
        provider: null,
    }),
}));
mock.module('../../../components/stickies/hooks/use-stickies-presence', () => ({
    useStickiesPresence: () => {},
    useCardPresence: () => new Map(),
}));
mock.module('../../../components/stickies/toolbar', () => ({ Toolbar: Nothing }));
mock.module('../../../components/stickies/column', () => ({
    Column: (props: { onCardOpen?: (id: string) => void }) => {
        seen.onCardOpen = props.onCardOpen;
        return null;
    },
}));
// Every request hangs, so the comment rows are what the test sets.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }),
);
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/ui/components/cards', () => realCards);
    mock.module('@workspace/ui/components/layout/app', () => realLayout);
    mock.module('@workspace/ui/components/search/doc-search-provider', () => realSearch);
    fetchSpy.mockRestore();
});

const { commentKeys } = await import('@workspace/lib/chat');
const { driveKeys } = await import('@workspace/lib/drive');
const { StickiesBoard } = await import('../../../components/stickies/board');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');

const path = drivePath({ id: 'b1', mountId: 'm1', name: 'Board', type: 'stickies', mimeType: DRIVE_MIME_STICKIES });

beforeEach(() => {
    doc = new Y.Doc();
    const card = new Y.Map<unknown>();
    card.set('title', 'Ship it');
    card.set('description', '');
    card.set('chatName', 'ship.eigenchat');
    doc.getMap('tasks').set('card-1', card);
    // The card is on the board while a column lists it.
    const column = new Y.Map<unknown>();
    column.set('taskIds', Y.Array.from(['card-1']));
    doc.getMap('columns').set('col', column);
});

let unmount = async () => {};
afterEach(() => unmount());

let history = router.createMemoryHistory();
const param = (name: string) => new URLSearchParams(history.location.search).get(name);
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? null;
async function closeDialog() {
    const close = document.querySelector<HTMLElement>('[role="dialog"] button[aria-label="Close"]');
    if (!close) throw new Error('no Close button');
    await act(async () => close.click());
    await settle();
}

// The board under a route that reads ?chat= and ?card=, as the board route does.
async function openBoard(entries: string[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(commentKeys.list('owner-1', 'm1', 'b1'), []);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner-1', 'm1', 'b1'), []);
    function Page() {
        const { chat, card } = router.useSearch({ strict: false });
        const navigate = router.useNavigate();
        return createElement(StickiesBoard, {
            ownerId: 'owner-1',
            path,
            canWrite: true,
            chatFolderId: 'chat-1',
            mediaFolderId: null,
            onAccessDialogOpen: () => {},
            chat,
            initialCardId: card,
            onClearInitialCard: () =>
                navigate({
                    to: '.',
                    search: (prev: { card?: string }) => ({ ...prev, card: undefined }),
                    replace: true,
                }),
        });
    }
    const root = router.createRootRoute({
        component: () => createElement(PreviewProvider, null, createElement(router.Outlet)),
    });
    const page = router.createRoute({
        getParentRoute: () => root,
        path: '/',
        validateSearch: (search: Record<string, unknown>): { chat?: string; card?: string } => ({
            ...(typeof search.chat === 'string' && { chat: search.chat }),
            ...(typeof search.card === 'string' && { card: search.card }),
        }),
        component: Page,
    });
    history = router.createMemoryHistory({ initialEntries: entries });
    const memory = router.createRouter({ routeTree: root.addChildren([page]), history });
    await memory.load();
    ({ unmount } = await renderInDocument(
        createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(router.RouterProvider, { router: memory }),
        ),
    ));
    await settle();
}

test("a link's ?chat= opens the board's dialog, and closing it takes ?chat= out", async () => {
    await openBoard(['/', '/?chat=ship.eigenchat']);
    expect(dialogText()).toContain('Ship it');
    await closeDialog();
    expect(param('chat')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
    expect(dialogText()).toBeNull();
});

test('a click on a card writes ?chat=, and closing goes back', async () => {
    await openBoard(['/']);
    await act(async () => seen.onCardOpen?.('card-1'));
    await settle();
    expect(param('chat')).toBe('ship.eigenchat');
    expect(dialogText()).toContain('Ship it');
    await closeDialog();
    expect(param('chat')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(0);
});

test("a card link's ?card= opens the dialog, and closing it drops ?card= by replace", async () => {
    await openBoard(['/', '/?card=card-1']);
    expect(dialogText()).toContain('Ship it');
    expect(param('chat')).toBeNull();
    await closeDialog();
    expect(param('card')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
    expect(dialogText()).toBeNull();
});

test('a ?chat= that names no card is dropped by replace', async () => {
    await openBoard(['/', '/?chat=unknown.eigenchat']);
    await settle();
    expect(param('chat')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
});
