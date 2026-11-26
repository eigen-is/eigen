// A canvas app's comments open in one column beside the canvas: the list at ?panel=comments, 256 wide like the
// properties panel, and a thread at ?chat=, 400 wide, with "‹ Comments" back to the list by replace and its scroll
// kept. The toolbar's toggle pushes, close goes back on that push, and X and Esc close the whole column from a thread
// too. A ?chat= landing opens at once at 400 and loads; one that names nothing lands on the list, a deleted one opens
// as deleted, and a card link's ?card= becomes its ?chat=. A landing reveals its anchor once, when its comment has
// loaded. The column eases between the list and a thread, each laid out at its own width. The editor beside it
// never remounts, on a desktop or a phone, and the find bar keeps clear of the column. The palette's In comments hit
// opens its thread the way a list row does.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { DocSearchController } from '@workspace/lib/types/doc-search';
import { drivePath } from '../../drive-path';
import { type } from '../../form-contract';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useRef, useSyncExternalStore } = await import('react');
const router = await import('@tanstack/react-router');
const { QueryClientProvider } = await import('@tanstack/react-query');
const realCollab = await import('@workspace/lib/collab');
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realThread = { ...(await import('../../../components/comments/comment-thread')) };
const realGuard = { ...(await import('../../../components/layout/app/unsynced-edits-guard')) };

// What the thread was last drawn with: its chat, and whether its reply box takes the focus.
const thread: { chatName?: string; autoFocus?: boolean } = {};

let doc = new Y.Doc();
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
// The socket's state, which drops on a disconnect and comes back on the next sync. The first sync happened.
let synced = true;
const syncListeners = new Set<() => void>();
const setSynced = async (next: boolean) => {
    await act(async () => {
        synced = next;
        for (const listener of syncListeners) listener();
    });
    await settle();
};
const subscribeSync = (listener: () => void) => {
    syncListeners.add(listener);
    return () => syncListeners.delete(listener);
};
// A canvas that loaded, with no server behind it.
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: (options: Parameters<typeof realCollab.useCollabDoc>[0]) => {
        const docRef = useRef(doc);
        const onInit = useRef(options.onInit);
        useEffect(() => onInit.current?.({ doc, provider, undoManager: null }), []);
        return {
            doc,
            docRef,
            provider,
            undoManager: null,
            synced: useSyncExternalStore(subscribeSync, () => synced),
            offline: false,
            loaded: true,
            storageUnavailable: false,
            storageGone: false,
            unsyncedEdits: false,
        };
    },
}));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: { email: 'me@example.com' } }) }));
// The thread's chat room fetches; only what the column hands it is under test here.
mock.module('../../../components/comments/comment-thread', () => ({
    CommentThread: (props: { chatName: string; autoFocus?: boolean }) => {
        thread.chatName = props.chatName;
        thread.autoFocus = props.autoFocus;
        return createElement('div', { 'data-testid': 'thread' }, props.chatName);
    },
}));
// The guard blocks a leave with unsynced edits, which this canvas never has.
mock.module('../../../components/layout/app/unsynced-edits-guard', () => ({ UnsyncedEditsGuard: () => null }));
// Every request hangs, so the comment rows and the chat folder are what the test sets.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }),
);
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('../../../components/comments/comment-thread', () => realThread);
    mock.module('../../../components/layout/app/unsynced-edits-guard', () => realGuard);
    fetchSpy.mockRestore();
    provider.destroy();
});

const { commentKeys } = await import('@workspace/lib/chat');
const { driveKeys, MediaResolverProvider } = await import('@workspace/lib/drive');
const { generateNKeysBetween, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import('@workspace/lib/vector');
const { CanvasDocumentShell, useCanvasCommentHost, useCanvasDoc } = await import('../../../components/vector');
const { eigenDocEditorValidateSearch } = await import('../../../components/drive/eigendoc-config');
const { LayoutContext } = await import('../../../components/layout/app/layout-context');
const { PreviewProvider } = await import('../../../components/preview-provider');
const { CommandPaletteProvider } = await import(
    '../../../components/layout/app/command-palette/command-palette-provider'
);
const { useOptionalCommandPalette } = await import('@workspace/lib/command-palette');

const path = drivePath({
    id: 'v1',
    ownerId: 'owner',
    mountId: 'mount',
    name: 'Plan.eigenvector',
    mimeType: 'application/eigenvector',
});
const searchController: DocSearchController = { search: () => [], reveal: () => {}, highlightAll: () => {} };

beforeEach(() => {
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    // A document-level comment, which no element anchors.
    const card = new Y.Map<unknown>();
    card.set('title', 'The title');
    card.set('description', '');
    card.set('chatName', 'thread-1.eigenchat');
    doc.getMap('comments').set('card-1', card);
    reveal.mockClear();
    thread.chatName = undefined;
    thread.autoFocus = undefined;
    mounts = 0;
    synced = true;
});

let unmount = async () => {};
afterEach(() => unmount());

let history: ReturnType<typeof router.createMemoryHistory> = router.createMemoryHistory();
const search = () => new URLSearchParams(history.location.search);
const historyIndex = () => history.location.state.__TSR_index;

// The editor beside the column: it counts its mounts, so a remount shows.
let mounts = 0;
function Editor() {
    useEffect(() => {
        mounts++;
    }, []);
    return createElement('div', { 'data-testid': 'editor' });
}

let openCard: (cardId: string) => void = () => {};
// The host's reveal, which Vector turns into a centering pan: the element and the room the column grows into.
const reveal = mock((_elementId: string, _growPx: number) => {});
let toggleComments: () => void = () => {};
// What the canvas published to the command palette.
let palette: ReturnType<typeof useOptionalCommandPalette> = null;
function PaletteProbe() {
    palette = useOptionalCommandPalette();
    return null;
}

// Rows null leave the comment index unanswered, as on a landing before it loads. A browser history runs the router's
// blockers on back, which a memory history skips.
type Options = {
    isMobile?: boolean;
    rows?: CommentEntry[] | null;
    initialSearchTerm?: string;
    browser?: boolean;
    canEdit?: boolean;
};

// The shell and its comments host under a route that reads the editor search, as the slide and vector routes do.
async function openCanvas(
    entries: string[],
    { isMobile = false, rows = [], initialSearchTerm, browser = false, canEdit = false }: Options = {},
) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    if (rows) queryClient.setQueryData(commentKeys.list('owner', 'mount', 'v1'), rows);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner', 'mount', 'v1'), []);
    queryClient.setQueryData(driveKeys.folder('owner', 'mount', 'chats'), [
        drivePath({ id: 'chat-1', ownerId: 'owner', mountId: 'mount', name: 'thread-1.eigenchat', mimeType: 'x' }),
    ]);
    function Page() {
        const { chat, card, panel } = router.useSearch({ strict: false });
        const canvas = useCanvasDoc('owner', 'mount', 'v1', VECTOR_STYLE_DEFAULTS);
        const comments = useCanvasCommentHost({
            ownerId: 'owner',
            path,
            canWrite: true,
            mediaFolderId: null,
            chatFolderId: 'chats',
            panel,
            chat,
            card,
            doc: canvas,
            onReveal: (el, growPx) => reveal(el.id, growPx),
        });
        openCard = comments.openCard;
        toggleComments = comments.column.toggleComments;
        return createElement(CanvasDocumentShell, {
            doc: canvas,
            comments,
            path,
            canWrite: true,
            canEdit,
            mediaFolderId: null,
            searchController,
            initialSearchTerm,
            imagePickerOpen: false,
            onImagePickerOpenChange: () => {},
            canvasRef: { current: null },
            toolbar: null,
            propertiesPanel: null,
            children: createElement(Editor),
        });
    }
    const root = router.createRootRoute({ component: router.Outlet });
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
                createElement(MediaResolverProvider, {
                    ownerId: 'owner',
                    mountId: 'mount',
                    mediaFolderId: null,
                    chatFolderId: 'chats',
                    children: createElement(
                        CommandPaletteProvider,
                        null,
                        createElement(PaletteProbe),
                        createElement(PreviewProvider, null, createElement(router.RouterProvider, { router: memory })),
                    ),
                }),
            ),
        ),
    ));
    await settle();
    return queryClient;
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const column = () => document.querySelector<HTMLElement>('[data-slot="detail-column"] > div');
const columnWidth = () => column()?.style.width;
const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-slot="detail-column"] button')].find(
        (b) => b.getAttribute('aria-label') === name || b.textContent === name,
    );
const listRow = () =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="detail-column"] .cursor-pointer')].find((tile) =>
        tile.textContent?.includes('The title'),
    );
const click = async (element: HTMLElement | null | undefined) => {
    if (!element) throw new Error('nothing to click');
    await act(async () => element.click());
    await settle();
};
const pressEscape = async () => {
    await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle();
};

test("the toolbar's toggle pushes ?panel=comments, and closing goes back over that push", async () => {
    await openCanvas(['/']);
    await act(async () => toggleComments());
    await settle();
    expect(search().get('panel')).toBe('comments');
    expect(historyIndex()).toBe(1);
    expect(columnWidth()).toBe('256px');
    await act(async () => toggleComments());
    await settle();
    expect(search().get('panel')).toBeNull();
    expect(historyIndex()).toBe(0);
    expect(column()).toBeNull();
});

test('a click on an anchor opens its thread at 400 straight away and writes ?chat=', async () => {
    await openCanvas(['/']);
    const widths: (string | undefined)[] = [];
    const observer = new MutationObserver(() => widths.push(columnWidth()));
    observer.observe(document.body, { subtree: true, attributes: true, childList: true });
    await act(async () => openCard('card-1'));
    await settle();
    observer.disconnect();
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(widths.filter((w) => w !== undefined).every((w) => w === '400px')).toBe(true);
    expect(columnWidth()).toBe('400px');
    expect(thread.chatName).toBe('thread-1.eigenchat');
    expect(button('Comments')).toBeDefined();
});

test("a list row reveals its anchor with the room the thread grows into, and the anchor's own click reveals nothing", async () => {
    const [key] = generateNKeysBetween(null, null, 1);
    const box = { type: 'rectangle' as const, x: 0, y: 0, width: 100, height: 100, commentCardIds: '["card-1"]' };
    writeElementInDoc(doc, box, key, VECTOR_STYLE_DEFAULTS, 'box');
    await openCanvas(['/', '/?panel=comments']);
    await click(listRow());
    expect(reveal.mock.calls).toEqual([['box', 144]]);
    await click(button('Comments'));
    reveal.mockClear();
    await act(async () => openCard('card-1'));
    await settle();
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(reveal).not.toHaveBeenCalled();
});

test('a ?chat= landing reveals its anchor once its comment has loaded, with the column already at its width', async () => {
    const [key] = generateNKeysBetween(null, null, 1);
    const box = { type: 'rectangle' as const, x: 0, y: 0, width: 100, height: 100, commentCardIds: '["card-1"]' };
    writeElementInDoc(doc, box, key, VECTOR_STYLE_DEFAULTS, 'box');
    const queryClient = await openCanvas(['/?chat=thread-1.eigenchat'], { rows: null });
    expect(reveal).not.toHaveBeenCalled();
    await act(async () => queryClient.setQueryData(commentKeys.list('owner', 'mount', 'v1'), []));
    await settle();
    expect(reveal.mock.calls).toEqual([['box', 0]]);
    await act(async () => writeElementInDoc(doc, { ...box, x: 10 }, key, VECTOR_STYLE_DEFAULTS, 'box'));
    await settle();
    expect(reveal).toHaveBeenCalledTimes(1);
});

// The landing reveals once, so an anchor that comes back later, such as through a peer's undo, moves nothing.
test('a ?chat= landing whose anchor is missing reveals nothing, even once the anchor comes', async () => {
    await openCanvas(['/?chat=thread-1.eigenchat']);
    const [key] = generateNKeysBetween(null, null, 1);
    const box = { type: 'rectangle' as const, x: 0, y: 0, width: 100, height: 100, commentCardIds: '["card-1"]' };
    await act(async () => writeElementInDoc(doc, box, key, VECTOR_STYLE_DEFAULTS, 'box'));
    await settle();
    expect(reveal).not.toHaveBeenCalled();
    expect(search().get('chat')).toBe('thread-1.eigenchat');
});

test("a card link's ?card= becomes its ?chat= by replace and opens the thread", async () => {
    await openCanvas(['/', '/?card=card-1']);
    expect(search().get('card')).toBeNull();
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(historyIndex()).toBe(1);
    expect(thread.chatName).toBe('thread-1.eigenchat');
});

test('a palette hit in comments opens its thread from a closed column, writes ?chat= and reveals its anchor once', async () => {
    const [key] = generateNKeysBetween(null, null, 1);
    const box = { type: 'rectangle' as const, x: 0, y: 0, width: 100, height: 100, commentCardIds: '["card-1"]' };
    writeElementInDoc(doc, box, key, VECTOR_STYLE_DEFAULTS, 'box');
    await openCanvas(['/']);
    expect(palette?.docCommentSearch?.docKey).toBe('owner:mount:v1');
    await act(async () => palette?.docCommentSearch?.reveal('thread-1.eigenchat'));
    await settle();
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(historyIndex()).toBe(1);
    expect(columnWidth()).toBe('400px');
    expect(thread.chatName).toBe('thread-1.eigenchat');
    expect(reveal.mock.calls).toEqual([['box', 144]]);
});

test('"‹ Comments" goes back to the list by replace, with its scroll kept', async () => {
    await openCanvas(['/', '/?panel=comments']);
    const list = listRow()?.closest<HTMLElement>('.overflow-y-auto');
    if (!list) throw new Error('no list scroller');
    list.scrollTop = 120;
    await click(listRow());
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(columnWidth()).toBe('400px');
    expect(historyIndex()).toBe(1);
    // Under the thread the list keeps the list's width, so its rows don't wrap again.
    expect(list.classList.contains('invisible')).toBe(true);
    expect(list.style.width).toBe('256px');
    await click(button('Comments'));
    expect(search().get('chat')).toBeNull();
    expect(search().get('panel')).toBe('comments');
    expect(historyIndex()).toBe(1);
    expect(columnWidth()).toBe('256px');
    const after = listRow()?.closest<HTMLElement>('.overflow-y-auto');
    expect(after).toBe(list);
    expect(after?.scrollTop).toBe(120);
    expect(after?.classList.contains('invisible')).toBe(false);
});

test('the column eases between the list and a thread, each laid out at its own width, and mounts at its width', async () => {
    await openCanvas(['/']);
    await act(async () => openCard('card-1'));
    await settle();
    // A fresh column at 400, so there is no width to ease from.
    const opened = column();
    expect(opened?.style.width).toBe('400px');
    await click(button('Close'));
    await act(async () => toggleComments());
    await settle();
    const list = column();
    expect(list).not.toBe(opened);
    expect(list?.className).toContain('transition-[width]');
    expect(list?.className).toContain('motion-reduce:transition-none');
    await click(listRow());
    // The same element grows, so the transition runs, and the thread is laid out at 400 from its first frame.
    expect(column()).toBe(list);
    expect(columnWidth()).toBe('400px');
    const body = document.querySelector<HTMLElement>('[data-slot="detail-column"] .absolute.flex-col');
    expect(body?.style.width).toBe('400px');
    await click(button('Comments'));
    expect(column()).toBe(list);
    expect(columnWidth()).toBe('256px');
});

test('X on a thread closes the whole column, back over the toggle that opened it', async () => {
    await openCanvas(['/']);
    await act(async () => toggleComments());
    await settle();
    await click(listRow());
    await click(button('Close'));
    expect(search().get('chat')).toBeNull();
    expect(search().get('panel')).toBeNull();
    expect(historyIndex()).toBe(0);
    expect(column()).toBeNull();
});

test('Esc on a thread closes the whole column', async () => {
    await openCanvas(['/', '/?panel=comments&chat=thread-1.eigenchat']);
    await pressEscape();
    expect(search().get('chat')).toBeNull();
    expect(search().get('panel')).toBeNull();
    // A link is no push of ours, so the close replaces it.
    expect(historyIndex()).toBe(1);
    expect(column()).toBeNull();
});

test('a ?chat= landing opens at 400 with a loader until the cards sync', async () => {
    // The comment rows have not come yet, so the lifecycle waits.
    await openCanvas(['/?chat=thread-1.eigenchat'], { rows: null });
    expect(columnWidth()).toBe('400px');
    expect(document.querySelector('[data-slot="detail-column"] [aria-label="Loading"]')).not.toBeNull();
});

test('a ?chat= that names no comment lands on the list by replace', async () => {
    await openCanvas(['/', '/?chat=unknown.eigenchat']);
    expect(search().get('chat')).toBeNull();
    expect(search().get('panel')).toBe('comments');
    expect(historyIndex()).toBe(1);
    expect(columnWidth()).toBe('256px');
});

test("a deleted comment's ?chat= opens it as deleted", async () => {
    doc.getMap('comments').delete('card-1');
    const row: CommentEntry = {
        chatName: 'thread-1.eigenchat',
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
    await openCanvas(['/?chat=thread-1.eigenchat'], { rows: [row] });
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(columnWidth()).toBe('400px');
    expect(column()?.textContent).toContain('This comment was deleted');
});

test('a click opens the thread with its reply box focused, a landing does not', async () => {
    await openCanvas(['/?chat=thread-1.eigenchat']);
    expect(thread.autoFocus).toBe(false);
    await click(button('Comments'));
    await click(listRow());
    expect(thread.autoFocus).toBe(true);
});

// A click marks only the thread it opened while that stays open, so coming forward to it again is a landing.
test('forward to a thread a click opened and X closed is a landing: no focus, and its anchor reveals', async () => {
    const [key] = generateNKeysBetween(null, null, 1);
    const box = { type: 'rectangle' as const, x: 0, y: 0, width: 100, height: 100, commentCardIds: '["card-1"]' };
    writeElementInDoc(doc, box, key, VECTOR_STYLE_DEFAULTS, 'box');
    await openCanvas(['/']);
    await act(async () => toggleComments());
    await settle();
    await click(listRow());
    expect(thread.autoFocus).toBe(true);
    await click(button('Close'));
    expect(historyIndex()).toBe(0);
    reveal.mockClear();
    await act(async () => history.forward());
    await settle();
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(thread.autoFocus).toBe(false);
    expect(reveal.mock.calls).toEqual([['box', 0]]);
});

test('the editor stays mounted through the list, a thread, back and close', async () => {
    await openCanvas(['/']);
    await act(async () => toggleComments());
    await settle();
    await click(listRow());
    await click(button('Comments'));
    await click(button('Close'));
    expect(mounts).toBe(1);
});

test('on a phone the column covers the editor, which stays mounted', async () => {
    await openCanvas(['/'], { isMobile: true });
    await act(async () => toggleComments());
    await settle();
    const editor = document.querySelector('[data-testid="editor"]');
    expect(editor?.closest('.hidden')).not.toBeNull();
    // The list's bar: "‹ Comments", back to the document.
    expect(button('Comments')).toBeDefined();
    expect(button('Back')).toBeUndefined();
    expect(column()?.className).not.toContain('transition-[width]');
    await click(listRow());
    expect(button('Comments')).toBeDefined();
    await click(button('Comments'));
    await click(button('Comments'));
    expect(column()).toBeNull();
    expect(document.querySelector('[data-testid="editor"]')?.closest('.hidden')).toBeNull();
    expect(mounts).toBe(1);
});

test("the find bar's inset follows the column as it grows into a thread", async () => {
    await openCanvas(['/', '/?panel=comments'], { initialSearchTerm: 'x' });
    const bar = () => document.querySelector<HTMLElement>('.absolute.right-4.z-10');
    expect(bar()?.style.right).toBe('272px');
    await click(listRow());
    expect(bar()?.style.right).toBe('416px');
    await click(button('Close'));
    expect(bar()?.style.right).toBe('');
});

test('the find bar clears the properties panel and the comments list alike on a desktop, and spans a phone', async () => {
    await openCanvas(['/'], { initialSearchTerm: 'x', canEdit: true });
    const bar = () => document.querySelector<HTMLElement>('.absolute.right-4.z-10');
    expect(bar()?.style.right).toBe('272px');
    // The comments list takes the panel's place at the panel's width, so the find bar stays put.
    await act(async () => toggleComments());
    await settle();
    expect(columnWidth()).toBe('256px');
    expect(bar()?.style.right).toBe('272px');
    await unmount();
    await openCanvas(['/'], { initialSearchTerm: 'x', canEdit: true, isMobile: true });
    expect(bar()?.style.right).toBe('');
});

test("a thread's Edit opens the card's form in a dialog over the column, and Cancel goes back to the thread", async () => {
    await openCanvas(['/?panel=comments&chat=thread-1.eigenchat']);
    await click(button('Edit'));
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Edit comment');
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (b) => b.textContent === 'Cancel',
    );
    await click(cancel);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(columnWidth()).toBe('400px');
});

test('a dropped connection keeps the open thread, its URL and an edit in progress', async () => {
    await openCanvas(['/', '/?panel=comments&chat=thread-1.eigenchat']);
    await click(button('Edit'));
    await type('Title', 'A new title');
    await setSynced(false);
    await setSynced(true);
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(historyIndex()).toBe(1);
    expect(columnWidth()).toBe('400px');
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value).toBe('A new title');
});

// Back closes or switches the thread without the edit dialog's own close, so a changed form asks through the router
// first, and the edit ends with its card, so the thread opens again in its view.
const editDialog = () =>
    [...document.querySelectorAll('[role="dialog"]')].find(
        (d) => d.querySelector('h2')?.textContent === 'Edit comment',
    );
const question = () =>
    [...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes('Discard changes?'));
const answer = async (name: string) =>
    click([...(question()?.querySelectorAll<HTMLElement>('button') ?? [])].find((b) => b.textContent === name));
const back = async () => {
    await act(async () => history.back());
    await settle();
};
async function editOpenThread() {
    await openCanvas(['/'], { browser: true });
    await act(async () => toggleComments());
    await settle();
    await click(listRow());
    await click(button('Edit'));
    await type('Title', 'A new title');
}

test('back with a changed edit asks first, and Keep editing keeps the URL and the form', async () => {
    await editOpenThread();
    await back();
    expect(question()).toBeDefined();
    await answer('Keep editing');
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(editDialog()?.querySelector('input')?.value).toBe('A new title');
});

test('Discard on back closes the column, and the thread opens again in its view', async () => {
    await editOpenThread();
    await back();
    await answer('Discard');
    expect(search().get('chat')).toBeNull();
    expect(column()).toBeNull();
    expect(editDialog()).toBeUndefined();

    await act(async () => openCard('card-1'));
    await settle();
    expect(search().get('chat')).toBe('thread-1.eigenchat');
    expect(editDialog()).toBeUndefined();
});
