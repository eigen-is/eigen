// The board opens a card in its own dialog, and the open thread is the route's ?chat=, as in every editor: a link, an
// activity row and a click on a card open it through the URL, and closing the dialog takes ?chat= out again. A copied
// card's ?card= becomes its ?chat= by replace. The activity is a 256 column under the toolbar at ?panel=activity, which
// covers the board on a phone without remounting it, and shares its entry with a card it opens.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { getIdArray } from '@workspace/lib/collab';
import { DRIVE_MIME_STICKIES } from '@workspace/lib/types/drive';
import type { FileEvent } from '@workspace/lib/types/file-history';
import { drivePath } from '@workspace/ui/test/drive-path';
import { type } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import type { ReactNode } from 'react';
import * as Y from 'yjs';

installHappyDom();

type ToolbarProps = { onToggleActivity?: () => void; activityOpen?: boolean };

// The props the toolbar, the find bar's provider and the first column were last rendered with.
const seen: {
    onCardOpen?: (id: string) => void;
    cardTitles?: string[];
    toolbar?: ToolbarProps;
    rightInsetPx?: number;
    onSearchOpenChange?: (open: boolean) => void;
} = {};
let doc = new Y.Doc();
let undoManager: Y.UndoManager | null = null;
// The board's column mounts, so a remount shows.
let mounts = 0;

const { act, createElement, useEffect, useSyncExternalStore } = await import('react');
// The socket's state, which drops on a disconnect and comes back on the next sync. The first sync happened.
let isSynced = true;
const syncListeners = new Set<() => void>();
const setSynced = (next: boolean) =>
    act(async () => {
        isSynced = next;
        for (const listener of syncListeners) listener();
    });
const subscribeSync = (listener: () => void) => {
    syncListeners.add(listener);
    return () => syncListeners.delete(listener);
};
const router = await import('@tanstack/react-router');
const { QueryClientProvider } = await import('@tanstack/react-query');
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCards = { ...(await import('@workspace/ui/components/cards')) };
const realLayout = { ...(await import('@workspace/ui/components/layout/app')) };
const realSearch = { ...(await import('@workspace/ui/components/search/doc-search-provider')) };
const realBoard = { ...(await import('../../../components/stickies/hooks/use-board')) };
const realPresence = { ...(await import('../../../components/stickies/hooks/use-stickies-presence')) };
const realToolbar = { ...(await import('../../../components/stickies/toolbar')) };
const realColumn = { ...(await import('../../../components/stickies/column')) };
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
}));
mock.module('@workspace/ui/components/search/doc-search-provider', () => ({
    ...realSearch,
    DocSearchProvider: (props: {
        rightInsetPx?: number;
        onOpenChange?: (open: boolean) => void;
        children?: ReactNode;
    }) => {
        seen.rightInsetPx = props.rightInsetPx;
        seen.onSearchOpenChange = props.onOpenChange;
        return props.children;
    },
}));
mock.module('../../../components/stickies/hooks/use-board', () => ({
    useBoard: () => ({
        isSynced: useSyncExternalStore(subscribeSync, () => isSynced),
        board: realBoard.readBoard(doc),
        isAddColumnDialogOpen: false,
        setIsAddColumnDialogOpen: () => {},
        handleAddColumn: () => {},
        deleteCardFromBoard: () => {},
        offline: false,
        loaded: true,
        storageUnavailable: false,
        storageGone: false,
        unsyncedEdits: false,
        yjsDoc: doc,
        undoManager,
        provider: null,
    }),
}));
mock.module('../../../components/stickies/hooks/use-stickies-presence', () => ({
    useStickiesPresence: () => {},
    useCardPresence: () => new Map(),
}));
mock.module('../../../components/stickies/toolbar', () => ({
    Toolbar: (props: ToolbarProps) => {
        seen.toolbar = props;
        return createElement('div', { 'data-testid': 'toolbar' });
    },
}));
mock.module('../../../components/stickies/column', () => ({
    Column: (props: { onCardOpen?: (id: string) => void; cards: { title: string }[] }) => {
        seen.onCardOpen = props.onCardOpen;
        seen.cardTitles = props.cards.map((card) => card.title);
        useEffect(() => {
            mounts++;
        }, []);
        return createElement('div', { 'data-testid': 'board-column' });
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
    mock.module('../../../components/stickies/hooks/use-board', () => realBoard);
    mock.module('../../../components/stickies/hooks/use-stickies-presence', () => realPresence);
    mock.module('../../../components/stickies/toolbar', () => realToolbar);
    mock.module('../../../components/stickies/column', () => realColumn);
    fetchSpy.mockRestore();
});

const { commentKeys } = await import('@workspace/lib/chat');
const { driveKeys } = await import('@workspace/lib/drive');
const { StickiesBoard } = await import('../../../components/stickies/board');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { eigenDocEditorValidateSearch } = await import('@workspace/ui/components/drive');
const { LayoutContext } = await import('@workspace/ui/components/layout/app/layout-context');

const path = drivePath({ id: 'b1', mountId: 'm1', name: 'Board', type: 'stickies', mimeType: DRIVE_MIME_STICKIES });

beforeEach(() => {
    isSynced = true;
    mounts = 0;
    undoManager = null;
    doc = new Y.Doc();
    const card = new Y.Map<unknown>();
    card.set('title', 'Ship it');
    card.set('description', '');
    card.set('chatName', 'ship.eigenchat');
    doc.getMap('tasks').set('card-1', card);
    // The card is on the board while a column lists it.
    const column = new Y.Map<unknown>();
    column.set('title', 'To do');
    column.set('taskIds', Y.Array.from(['card-1']));
    doc.getMap('columns').set('col', column);
    doc.getArray('columnOrder').push(['col']);
});

let unmount = async () => {};
afterEach(() => unmount());

let history: ReturnType<typeof router.createMemoryHistory> = router.createMemoryHistory();
const param = (name: string) => new URLSearchParams(history.location.search).get(name);
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? null;
async function closeDialog() {
    const close = document.querySelector<HTMLElement>('[role="dialog"] button[aria-label="Close"]');
    if (!close) throw new Error('no Close button');
    await act(async () => close.click());
    await settle();
}

// The activity's one row, a card added to the board.
const cardAdded: FileEvent = {
    id: 'e1',
    pathId: 'b1',
    pathName: 'Board',
    pathType: 'file',
    actorUserId: 'u2',
    actorEmail: 'bob@example.com',
    createdAt: new Date('2026-11-01T10:00:00Z'),
    eventType: 'card-added',
    details: { card: 'Ship it', toColumn: 'To do', cardId: 'card-1' },
};

// The board under a route that reads the editor search, as the board route does.
// A browser history runs the router's blockers on back, which a memory history skips.
async function openBoard(entries: string[], { browser = false, isMobile = false } = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(commentKeys.list('owner-1', 'm1', 'b1'), []);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner-1', 'm1', 'b1'), []);
    queryClient.setQueryData(driveKeys.fileHistory('owner-1', 'm1', 'b1', 50), [cardAdded]);
    function Page() {
        return createElement(StickiesBoard, {
            path,
            canWrite: true,
            chatFolderId: 'chat-1',
            mediaFolderId: null,
            onAccessDialogOpen: () => {},
        });
    }
    const root = router.createRootRoute({
        component: () => createElement(PreviewProvider, null, createElement(router.Outlet)),
    });
    const page = router.createRoute({
        getParentRoute: () => root,
        path: '/',
        validateSearch: eigenDocEditorValidateSearch,
        component: Page,
    });
    if (browser) window.history.replaceState(null, '', entries[0]);
    history = browser ? router.createBrowserHistory() : router.createMemoryHistory({ initialEntries: entries });
    const memory = router.createRouter({ routeTree: root.addChildren([page]), history });
    await memory.load();
    const layout = {
        appName: '',
        setAppName: () => {},
        documentTitle: '',
        setDocumentTitle: () => {},
        sidebarOpen: false,
        setSidebarOpen: () => {},
        sidebarColumnShown: false,
        sidebarMode: 'collapsible' as const,
        sidebarHidden: false,
        setSidebarHidden: () => {},
        isMobile,
        isTablet: false,
    };
    ({ unmount } = await renderInDocument(
        createElement(
            LayoutContext.Provider,
            { value: layout },
            createElement(
                QueryClientProvider,
                { client: queryClient },
                createElement(router.RouterProvider, { router: memory }),
            ),
        ),
    ));
    await settle();
}

// A card with no thread is no card, such as one an older board stored, so the board leaves it out.
test('a card without a chatName is left out, and the board shows its other cards', async () => {
    doc.transact(() => {
        doc.getMap('tasks').set('card-2', new Y.Map());
        getIdArray(doc.getMap('columns').get('col'), 'taskIds')?.push(['card-2']);
    });
    await openBoard(['/']);
    expect(seen.cardTitles).toEqual(['Ship it']);
});

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

test("a card link's ?card= becomes the card's ?chat= by replace, and closing it replaces too", async () => {
    await openBoard(['/', '/?card=card-1']);
    expect(param('card')).toBeNull();
    expect(param('chat')).toBe('ship.eigenchat');
    expect(history.location.state.__TSR_index).toBe(1);
    expect(dialogText()).toContain('Ship it');
    await closeDialog();
    expect(param('chat')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
    expect(dialogText()).toBeNull();
});

test('a ?card= that names no card is dropped by replace', async () => {
    await openBoard(['/', '/?card=card-9']);
    expect(param('card')).toBeNull();
    expect(param('chat')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
    expect(dialogText()).toBeNull();
});

test('a ?chat= that names no card is dropped by replace', async () => {
    await openBoard(['/', '/?chat=unknown.eigenchat']);
    await settle();
    expect(param('chat')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
});

test('a dropped connection keeps the open thread, its URL and an edit in progress', async () => {
    await openBoard(['/', '/?chat=ship.eigenchat']);
    await act(async () => document.querySelector<HTMLElement>('[role="dialog"] button[aria-label="Edit"]')?.click());
    await type('Title', 'Ship it today');
    await setSynced(false);
    await settle();
    await setSynced(true);
    await settle();
    expect(param('chat')).toBe('ship.eigenchat');
    expect(history.location.state.__TSR_index).toBe(1);
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('Ship it today');
});

// Back, or a second link, closes or switches the card without the dialog's own close, so a changed edit form asks
// through the router first, and the edit ends with its card, so the card opens again in its view.
const editButton = () => document.querySelector<HTMLElement>('[role="dialog"] button[aria-label="Edit"]');
const question = () =>
    [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes('Discard changes?'));
const questionButton = (name: string) => {
    const found = [...(question()?.querySelectorAll<HTMLElement>('button') ?? [])].find((b) => b.textContent === name);
    if (!found) throw new Error(`no ${name} button`);
    return found;
};
const back = async () => {
    await act(async () => history.back());
    await settle();
};

test('back with a changed edit form asks first, and Keep editing keeps the URL and the form', async () => {
    await openBoard(['/'], { browser: true });
    await act(async () => seen.onCardOpen?.('card-1'));
    await settle();
    await act(async () => editButton()?.click());
    await type('Title', 'Ship it today');
    await back();
    expect(question()).toBeDefined();
    await act(async () => questionButton('Keep editing').click());
    await settle();
    expect(param('chat')).toBe('ship.eigenchat');
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('Ship it today');
});

test('Discard on back closes the card, which opens again in its view', async () => {
    await openBoard(['/'], { browser: true });
    await act(async () => seen.onCardOpen?.('card-1'));
    await settle();
    await act(async () => editButton()?.click());
    await type('Title', 'Ship it today');
    await back();
    await act(async () => questionButton('Discard').click());
    await settle();
    expect(param('chat')).toBeNull();
    expect(dialogText()).toBeNull();

    await act(async () => seen.onCardOpen?.('card-1'));
    await settle();
    expect(editButton()).not.toBeNull();
    expect(document.querySelector('[role="dialog"] input')).toBeNull();
});

test('back from an unchanged edit closes at once, and the card opens again in its view', async () => {
    await openBoard(['/']);
    await act(async () => seen.onCardOpen?.('card-1'));
    await settle();
    await act(async () => editButton()?.click());
    await back();
    expect(question()).toBeUndefined();
    expect(param('chat')).toBeNull();

    await act(async () => seen.onCardOpen?.('card-1'));
    await settle();
    expect(editButton()).not.toBeNull();
});

test("the dialog's X on a changed edit asks once, and Discard closes the card and takes ?chat= out", async () => {
    await openBoard(['/'], { browser: true });
    await act(async () => seen.onCardOpen?.('card-1'));
    await settle();
    await act(async () => editButton()?.click());
    await type('Title', 'Ship it today');
    await act(async () => document.querySelector<HTMLElement>('[data-slot="dialog-close"]')?.click());
    await settle();
    await act(async () => questionButton('Discard').click());
    await settle();
    expect(question()).toBeUndefined();
    expect(param('chat')).toBeNull();
    expect(dialogText()).toBeNull();
});

const column = () => document.querySelector<HTMLElement>('[data-slot="detail-column"] > div');
// The row the column sits in, beside the board and under the toolbar.
const slotRow = () => document.querySelector('[data-slot="detail-column"]')?.parentElement;
const columnButton = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-slot="detail-column"] button')].find(
        (b) => b.getAttribute('aria-label') === name || b.textContent === name,
    );
const boardHidden = () => document.querySelector('[data-testid="board-column"]')?.closest('.hidden') != null;
const toggleActivity = async () => {
    await act(async () => seen.toolbar?.onToggleActivity?.());
    await settle();
};
const pressEscape = async () => {
    await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle();
};

test("the toolbar's Activity pushes ?panel=activity and shows the list at 256 under the toolbar; X goes back", async () => {
    await openBoard(['/']);
    await toggleActivity();
    expect(param('panel')).toBe('activity');
    expect(history.location.state.__TSR_index).toBe(1);
    expect(seen.toolbar?.activityOpen).toBe(true);
    expect(column()?.style.width).toBe('256px');
    expect(column()?.querySelector('.eigen-toolbar-title')?.textContent).toBe('Activity');
    expect(slotRow()?.querySelector('[data-testid="board-column"]')).not.toBeNull();
    expect(slotRow()?.querySelector('[data-testid="toolbar"]')).toBeNull();
    expect(seen.rightInsetPx).toBe(256);

    await act(async () => columnButton('Close')?.click());
    await settle();
    expect(param('panel')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(0);
    expect(column()).toBeNull();
    expect(seen.rightInsetPx).toBeUndefined();
});

test('on a link Esc closes the activity by replace, and the toggle closes it too', async () => {
    await openBoard(['/', '/?panel=activity']);
    expect(column()).not.toBeNull();
    await pressEscape();
    expect(param('panel')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
    expect(column()).toBeNull();

    await toggleActivity();
    await toggleActivity();
    expect(param('panel')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
});

test("an activity row opens the card's dialog over the column, and closing the dialog leaves the column", async () => {
    await openBoard(['/']);
    await toggleActivity();
    await act(async () => column()?.querySelector<HTMLElement>('[role="button"]')?.click());
    await settle();
    expect(param('chat')).toBe('ship.eigenchat');
    expect(param('panel')).toBe('activity');
    expect(dialogText()).toContain('Ship it');
    expect(column()).not.toBeNull();

    // An Esc the dialog doesn't take still leaves the column alone while the dialog is open.
    await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    await settle();
    expect(param('panel')).toBe('activity');
    await closeDialog();
    expect(param('chat')).toBeNull();
    expect(param('panel')).toBe('activity');
    expect(history.location.state.__TSR_index).toBe(1);
    expect(column()).not.toBeNull();
});

// The activity and the card it opened share one entry, so a delete leaves only the activity on it.
test('a card an activity row opened and then deleted leaves one entry: one X closes, and back opens nothing', async () => {
    await openBoard(['/', '/']);
    await toggleActivity();
    await act(async () => column()?.querySelector<HTMLElement>('[role="button"]')?.click());
    await settle();
    expect(param('chat')).toBe('ship.eigenchat');
    await act(async () => editButton()?.click());
    await act(async () => document.querySelector<HTMLElement>('[role="dialog"] button[aria-label="Delete"]')?.click());
    await settle();
    const confirm = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
        d.textContent?.includes('Delete card'),
    );
    await act(async () => confirm?.querySelector<HTMLElement>('button[data-variant="destructive"]')?.click());
    await settle();
    expect(param('chat')).toBeNull();
    expect(param('panel')).toBe('activity');

    await act(async () => columnButton('Close')?.click());
    await settle();
    expect(column()).toBeNull();
    expect(param('panel')).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
    await back();
    expect([param('panel'), param('chat'), column(), dialogText()]).toEqual([null, null, null, null]);
});

test('on a phone the activity covers the board, which never remounts, and ‹ Activity closes it', async () => {
    await openBoard(['/'], { isMobile: true });
    expect(seen.toolbar?.onToggleActivity).toBeDefined();
    await toggleActivity();
    expect(boardHidden()).toBe(true);
    expect(column()?.closest('.hidden')).toBeNull();
    expect(seen.rightInsetPx).toBeUndefined();
    expect(columnButton('Back')).toBeUndefined();
    await act(async () => columnButton('Activity')?.click());
    await settle();
    expect(param('panel')).toBeNull();
    expect(column()).toBeNull();
    expect(boardHidden()).toBe(false);
    expect(mounts).toBe(1);
});

test('on a phone the find bar opening closes the activity that covers it', async () => {
    await openBoard(['/', '/?panel=activity'], { isMobile: true });
    await act(async () => seen.onSearchOpenChange?.(true));
    await settle();
    expect(param('panel')).toBeNull();
    expect(boardHidden()).toBe(false);
});

test('⌘Z with the focus in the activity leaves the board alone, and on the board undoes', async () => {
    const MOD = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
    const columns = doc.getMap('columns');
    undoManager = new Y.UndoManager(columns);
    columns.set('col-2', new Y.Map());
    await openBoard(['/?panel=activity']);
    const close = columnButton('Close');
    await act(async () => close?.focus());
    await act(async () => {
        close?.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', bubbles: true, ...MOD }));
    });
    expect(columns.has('col-2')).toBe(true);

    await act(async () => close?.blur());
    await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', bubbles: true, ...MOD }));
    });
    expect(columns.has('col-2')).toBe(false);
});
