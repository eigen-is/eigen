// The sheet editor's side of a comment. The grid's hover report drives the hover card, and a card opened from it or
// from a cell opens its thread where the pointer already is. Comments open in one column in the workbook's right slot:
// the list at ?panel=, 256 wide, and a thread at ?chat=, 400 wide, which a list row opens after a jump to its first
// cell. The column takes the image and chart panel's place while it is open; on a phone it covers the workbook, which
// never remounts. The find bar keeps clear of the slot. The grid and the find bar's provider render as probes that keep
// their props, since they are tested where they live; the column and its lifecycle are the real ones.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { SheetFloatingItem } from '@workspace/lib/sheets';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentHoverTarget } from '@workspace/lib/types/comments';
import type { DocCommentSearch } from '@workspace/lib/types/doc-search';
import type { Sheet } from '@workspace/sheet';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import type { CSSProperties, ReactNode } from 'react';

installHappyDom();

const Y = await import('yjs');
const { act, createElement, useEffect } = await import('react');
const router = await import('@tanstack/react-router');
const { QueryClientProvider } = await import('@tanstack/react-query');

type GridProps = {
    ref: { current: unknown };
    toolbarRightItems: ReactNode;
    rightSlot: ReactNode;
    onChange: (sheets: readonly Sheet[], shown: string) => void;
    hooks: {
        onCommentHover: (target: CommentHoverTarget | null) => void;
        onActiveObjectChange: (item: SheetFloatingItem | null) => void;
        commentLifecycle: { setOpenCardId: (cardId: string | null) => void };
    };
};
type HoverCardProps = { onOpenCard: (cardId: string) => void } & Record<string, unknown>;
type SearchProps = { commentSearch?: DocCommentSearch; barStyle?: CSSProperties; children?: ReactNode };

const seen: {
    grid?: GridProps;
    hoverCard?: HoverCardProps;
    toggleComments?: () => void;
    toggleActivity?: () => void;
    search?: SearchProps;
} = {};
// The grid's mounts, so a remount shows, and the cell jumps and focus calls it took.
let mounts = 0;
const calls: unknown[] = [];
const workbook = {
    revealSearchMatch: (cell: unknown) => calls.push(['reveal', cell]),
    focusGrid: () => calls.push(['focus grid']),
};
const hover = { target: null, report: mock(), enterCard: mock(), leaveCard: mock(), dismiss: mock() };
let doc = new Y.Doc();
const sheet = {
    initialData: [{ id: 's1', name: 'One', order: 0 }],
    loadFailed: false,
    synced: true,
    offline: false,
    loaded: true,
    storageUnavailable: false,
    storageGone: false,
    unsyncedEdits: false,
    handleOp: () => {},
    docRef: { current: doc },
    provider: null,
};
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };

// Copies, because mock.module rewrites a loaded module's exports in place.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realComments = { ...(await import('@workspace/lib/comments')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realSheet = { ...(await import('@workspace/sheet')) };
const realLayout = { ...(await import('@workspace/ui/components/layout/app')) };
const realToolbar = { ...(await import('@workspace/ui/components/layout/toolbar')) };
const realDropOverlay = { ...(await import('@workspace/ui/components/file-drop-overlay')) };
const realUiComments = { ...(await import('@workspace/ui/components/comments')) };
const realThread = { ...(await import('@workspace/ui/components/comments/comment-thread')) };
const realSearch = { ...(await import('@workspace/ui/components/search/doc-search-provider')) };
const realCards = { ...(await import('@workspace/ui/components/cards')) };

const Children = ({ children }: { children?: ReactNode }) => children;
const Nothing = () => null;
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/comments', () => ({ ...realComments, useCommentHover: () => hover }));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useCopyToMediaFolder: () => ({ mutateAsync: () => {} }),
    useUploadFile: () => ({ mutateAsync: () => {} }),
    useZombieMediaSweep: () => {},
}));
function Grid(props: GridProps) {
    seen.grid = props;
    props.ref.current = workbook;
    useEffect(() => {
        mounts++;
    }, []);
    return createElement(
        'div',
        { 'data-testid': 'grid' },
        props.toolbarRightItems,
        createElement('div', { 'data-testid': 'slot' }, props.rightSlot),
    );
}
mock.module('@workspace/sheet', () => ({ ...realSheet, Workbook: Grid }));
mock.module('@workspace/ui/components/layout/app', () => ({
    ...realLayout,
    CollabDocumentGate: Children,
    UnsyncedEditsGuard: Nothing,
}));
mock.module('@workspace/ui/components/layout/toolbar', () => ({
    ...realToolbar,
    DocumentShareCluster: (props: { onToggleCommentPanel: () => void; onToggleActivityPanel: () => void }) => {
        seen.toggleComments = props.onToggleCommentPanel;
        seen.toggleActivity = props.onToggleActivityPanel;
        return null;
    },
}));
mock.module('@workspace/ui/components/file-drop-overlay', () => ({ ...realDropOverlay, FileDropOverlay: Nothing }));
mock.module('@workspace/ui/components/comments', () => ({
    ...realUiComments,
    CommentHoverCard: (props: HoverCardProps) => {
        seen.hoverCard = props;
        return null;
    },
    CommentLifecycleDialogs: Nothing,
}));
// The thread's chat room fetches; only what the column hands it is under test here.
mock.module('@workspace/ui/components/comments/comment-thread', () => ({
    CommentThread: (props: { chatName: string }) => createElement('div', { 'data-testid': 'thread' }, props.chatName),
}));
mock.module('@workspace/ui/components/search/doc-search-provider', () => ({
    ...realSearch,
    DocSearchProvider: (props: SearchProps) => {
        seen.search = props;
        return props.children;
    },
}));
mock.module('@workspace/ui/components/cards', () => ({ ...realCards, CardFormDialog: Nothing }));
mock.module('../../../components/sheets/hooks/use-sheet', () => ({ useSheet: () => sheet }));
mock.module('../../../components/sheets/hooks/use-presence', () => ({ usePresence: () => () => {} }));
mock.module('../../../components/sheets/hooks/use-search-controller', () => ({
    useSheetSearchController: () => null,
}));
// Every request hangs, so the comment rows and the chat folder are what the test sets.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }),
);
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/comments', () => realComments);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/sheet', () => realSheet);
    mock.module('@workspace/ui/components/layout/app', () => realLayout);
    mock.module('@workspace/ui/components/layout/toolbar', () => realToolbar);
    mock.module('@workspace/ui/components/file-drop-overlay', () => realDropOverlay);
    mock.module('@workspace/ui/components/comments', () => realUiComments);
    mock.module('@workspace/ui/components/comments/comment-thread', () => realThread);
    mock.module('@workspace/ui/components/search/doc-search-provider', () => realSearch);
    mock.module('@workspace/ui/components/cards', () => realCards);
    fetchSpy.mockRestore();
});

const { commentKeys } = await import('@workspace/lib/chat');
const { driveKeys, MediaResolverProvider } = await import('@workspace/lib/drive');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { eigenDocEditorValidateSearch } = await import('@workspace/ui/components/drive');
const { LayoutContext } = await import('@workspace/ui/components/layout/app/layout-context');
const { SheetEditor } = await import('../../../components/sheets/editor');

const path = drivePath({
    id: 'x1',
    ownerId: 'owner-1',
    mountId: 'm1',
    name: 'Book.eigensheet',
    mimeType: 'application/eigensheet',
});

// The card sits on the second tab, which is not the open one.
const FIRST_CELL = { sheetId: 's2', r: 1, c: 1 };
const tabs: Sheet[] = [
    { id: 's1', name: 'One', order: 0, data: [[null]] },
    { id: 's2', name: 'Two', order: 1, data: [[null], [null, { commentCardIds: ['c1'] }]] },
];
const image: SheetFloatingItem = {
    kind: 'image',
    object: { id: 'i1', mediaName: 'a.png', x: 0, y: 0, width: 10, height: 10, index: 'a0' },
};

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    calls.length = 0;
    mounts = 0;
    hover.report.mockClear();
    doc = new Y.Doc();
    sheet.docRef.current = doc;
    const card = new Y.Map<unknown>();
    card.set('title', 'One');
    card.set('description', '');
    card.set('chatName', 'chat-1.eigenchat');
    doc.getMap('comments').set('c1', card);
});

let history = router.createMemoryHistory();
const search = () => new URLSearchParams(history.location.search);
const historyIndex = () => history.location.state.__TSR_index;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

// The editor under a route that reads the editor search, as the sheet route does. Rows null leave the comment index
// unanswered.
async function renderEditor(entries = ['/'], { isMobile = false, rows = [] as CommentEntry[] | null } = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    if (rows) queryClient.setQueryData(commentKeys.list('owner-1', 'm1', 'x1'), rows);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner-1', 'm1', 'x1'), []);
    queryClient.setQueryData(driveKeys.folder('owner-1', 'm1', 'chats'), [
        drivePath({ id: 'chat-a', ownerId: 'owner-1', mountId: 'm1', name: 'chat-1.eigenchat', mimeType: 'x' }),
    ]);
    function Page() {
        const { chat, panel } = router.useSearch({ strict: false });
        return createElement(SheetEditor, {
            ownerId: 'owner-1',
            path,
            canWrite: true,
            mediaFolderId: null,
            chatFolderId: 'chats',
            onAccessDialogOpen: () => {},
            panel,
            chat,
        });
    }
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({
        getParentRoute: () => root,
        path: '/',
        validateSearch: eigenDocEditorValidateSearch,
        component: Page,
    });
    history = router.createMemoryHistory({ initialEntries: entries });
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
                createElement(MediaResolverProvider, {
                    ownerId: 'owner-1',
                    mountId: 'm1',
                    mediaFolderId: null,
                    chatFolderId: 'chats',
                    children: createElement(
                        PreviewProvider,
                        null,
                        createElement(router.RouterProvider, { router: memory }),
                    ),
                }),
            ),
        ),
    ));
    const { grid } = seen;
    if (!grid) throw new Error('the editor did not render');
    await act(async () => grid.onChange(tabs, 's1'));
    await settle();
    return grid;
}

const column = () => document.querySelector<HTMLElement>('[data-slot="detail-column"] > div');
const columnWidth = () => column()?.style.width;
const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-slot="detail-column"] button')].find(
        (b) => b.getAttribute('aria-label') === name || b.textContent === name,
    );
const listRow = () =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="detail-column"] .cursor-pointer')].find((tile) =>
        tile.textContent?.includes('One'),
    );
const threadShown = () => document.querySelector('[data-testid="thread"]')?.textContent;
const propertiesTitle = () =>
    [...document.querySelectorAll('.eigen-toolbar-title')].find((title) => title.textContent === 'Image');
const inSlot = (element: Element | undefined) => element?.closest('[data-testid="slot"]') != null;
const gridHidden = () => document.querySelector('[data-testid="grid"]')?.closest('.hidden') != null;
const click = async (element: HTMLElement | null | undefined) => {
    if (!element) throw new Error('nothing to click');
    await act(async () => element.click());
    await settle();
};
const run = async (action: (() => void) | undefined) => {
    await act(async () => action?.());
    await settle();
};

test('a report from the grid shows the hover card on that cell, and none hides it', async () => {
    const grid = await renderEditor();
    const rect = new DOMRect(10, 20, 74, 20);
    grid.hooks.onCommentHover({ cardId: 'c1', rect });
    expect(hover.report).toHaveBeenLastCalledWith({ cardId: 'c1', rect });
    grid.hooks.onCommentHover(null);
    expect(hover.report).toHaveBeenLastCalledWith(null);
});

test('the hover card floats beside the cell and reads the cards the column reads', async () => {
    await renderEditor();
    expect(seen.hoverCard).toMatchObject({ hover, side: 'right' });
    expect(Object.keys((seen.hoverCard?.cards as object) ?? {})).toEqual(['c1']);
});

test.each([
    ['the hover card', () => seen.hoverCard?.onOpenCard('c1')],
    ["a cell's comment marker", () => seen.grid?.hooks.commentLifecycle.setOpenCardId('c1')],
])('a click on %s opens the thread at 400 in the slot and moves nothing', async (_, open) => {
    await renderEditor();
    await run(open);
    expect(search().get('chat')).toBe('chat-1.eigenchat');
    expect(columnWidth()).toBe('400px');
    expect(threadShown()).toBe('chat-1.eigenchat');
    expect(calls).toEqual([]);
});

test.each([
    ['Comments', 'comments', () => seen.toggleComments],
    ['Activity', 'activity', () => seen.toggleActivity],
])(
    "the toolbar's %s pushes ?panel=%s and opens its list at 256 in the slot; X and Esc close it",
    async (title, panel, toggle) => {
        await renderEditor();
        await run(toggle());
        expect(search().get('panel')).toBe(panel);
        expect(historyIndex()).toBe(1);
        expect(columnWidth()).toBe('256px');
        expect(column()?.querySelector('.eigen-toolbar-title')?.textContent).toBe(title);
        expect(inSlot(column() ?? undefined)).toBe(true);
        await click(button('Close'));
        expect(search().get('panel')).toBeNull();
        expect(historyIndex()).toBe(0);
        expect(column()).toBeNull();

        await run(toggle());
        await act(async () => {
            document.body.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
        });
        await settle();
        expect(search().get('panel')).toBeNull();
        expect(column()).toBeNull();
    },
);

// The thread's reply box takes the focus on a click, so the jump leaves the focus where it is.
test("a list row jumps to the card's first cell and opens its thread, and ‹ Comments goes back", async () => {
    await renderEditor(['/', '/?panel=comments']);
    await click(listRow());
    expect(calls).toEqual([['reveal', FIRST_CELL]]);
    expect(search().get('chat')).toBe('chat-1.eigenchat');
    expect(historyIndex()).toBe(1);
    expect(columnWidth()).toBe('400px');
    await click(button('Comments'));
    expect(search().get('chat')).toBeNull();
    expect(search().get('panel')).toBe('comments');
    expect(columnWidth()).toBe('256px');
});

test('a ?chat= landing opens the thread at 400 and jumps to its cell', async () => {
    await renderEditor(['/?chat=chat-1.eigenchat']);
    expect(columnWidth()).toBe('400px');
    expect(threadShown()).toBe('chat-1.eigenchat');
    expect(calls).toEqual([['reveal', FIRST_CELL]]);
});

test("a deleted comment's ?chat= opens it as deleted", async () => {
    doc.getMap('comments').delete('c1');
    const row: CommentEntry = {
        chatName: 'chat-1.eigenchat',
        status: 'open',
        resolvedBy: null,
        resolvedAt: null,
        lastAuthorEmail: null,
        lastActivityAt: null,
        messageCount: 0,
        createdAt: new Date('2026-11-01T09:00:00Z'),
        assignee: null,
        title: 'Gone',
    };
    await renderEditor(['/?chat=chat-1.eigenchat'], { rows: [row] });
    expect(search().get('chat')).toBe('chat-1.eigenchat');
    expect(columnWidth()).toBe('400px');
    expect(column()?.textContent).toContain('This comment was deleted');
});

test('a ?chat= that names no comment lands on the list by replace', async () => {
    await renderEditor(['/', '/?chat=unknown.eigenchat']);
    expect(search().get('chat')).toBeNull();
    expect(search().get('panel')).toBe('comments');
    expect(historyIndex()).toBe(1);
    expect(columnWidth()).toBe('256px');
});

test('a palette hit in comments opens its thread from a closed column, jumps to the cell and writes ?chat=', async () => {
    await renderEditor();
    expect(seen.search?.commentSearch?.docKey).toBe('owner-1:m1:x1');
    await run(() => seen.search?.commentSearch?.reveal('chat-1.eigenchat'));
    expect(search().get('chat')).toBe('chat-1.eigenchat');
    expect(columnWidth()).toBe('400px');
    expect(calls).toEqual([['reveal', FIRST_CELL]]);
});

test.each([
    ['a desktop', false],
    ['a phone', true],
])('on %s the workbook stays mounted through the list, a thread, back and close', async (_, isMobile) => {
    await renderEditor(['/'], { isMobile });
    await run(seen.toggleComments);
    // On a phone the column covers the workbook, which is hidden, not unmounted; on a desktop it is in the slot.
    expect(gridHidden()).toBe(isMobile);
    expect(inSlot(column() ?? undefined)).toBe(!isMobile);
    await click(listRow());
    expect(threadShown()).toBe('chat-1.eigenchat');
    await click(button('Comments'));
    await click(button(isMobile ? 'Back' : 'Close'));
    expect(column()).toBeNull();
    expect(gridHidden()).toBe(false);
    expect(mounts).toBe(1);
});

test("a selected image's panel shows in the slot and yields to the column while it is open", async () => {
    const grid = await renderEditor();
    await run(() => grid.hooks.onActiveObjectChange(image));
    expect(propertiesTitle()).toBeDefined();
    expect(inSlot(propertiesTitle())).toBe(true);
    await run(seen.toggleComments);
    expect(propertiesTitle()).toBeUndefined();
    expect(columnWidth()).toBe('256px');
    await click(button('Close'));
    expect(propertiesTitle()).toBeDefined();
});

test('a phone shows no image panel', async () => {
    const grid = await renderEditor(['/'], { isMobile: true });
    await run(() => grid.hooks.onActiveObjectChange(image));
    expect(propertiesTitle()).toBeUndefined();
});

test("the find bar's inset follows the slot: none empty, the panel's or the list's 256, a thread's 400", async () => {
    const grid = await renderEditor();
    expect(seen.search?.barStyle).toBeUndefined();
    await run(() => grid.hooks.onActiveObjectChange(image));
    expect(seen.search?.barStyle).toEqual({ right: 272 });
    await run(() => grid.hooks.onActiveObjectChange(null));
    await run(seen.toggleComments);
    expect(seen.search?.barStyle).toEqual({ right: 272 });
    await click(listRow());
    expect(seen.search?.barStyle).toEqual({ right: 416 });
    await click(button('Close'));
    expect(seen.search?.barStyle).toBeUndefined();
});

test('on a phone the find bar spans the screen', async () => {
    await renderEditor(['/'], { isMobile: true });
    await run(seen.toggleComments);
    expect(seen.search?.barStyle).toBeUndefined();
});
