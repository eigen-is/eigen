// A canvas app's open comment thread is its route's ?chat=, as in every editor: a link opens the card dialog the shell
// draws, closing it takes ?chat= out of the URL, and a ?chat= that names no comment is dropped by replace.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { DocSearchController } from '@workspace/lib/types/doc-search';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useRef } = await import('react');
const router = await import('@tanstack/react-router');
const { QueryClientProvider } = await import('@tanstack/react-query');
const realCollab = await import('@workspace/lib/collab');
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCardDialog = { ...(await import('../../../components/cards/card-dialog')) };
const realGuard = { ...(await import('../../../components/layout/app/unsynced-edits-guard')) };

// The props the card dialog was last rendered with.
const seen: { open?: boolean; onOpenChange?: (open: boolean) => void } = {};

let doc = new Y.Doc();
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
// A synced canvas, with no server behind it.
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: () => {
        const docRef = useRef(doc);
        return {
            doc,
            docRef,
            provider,
            undoManager: null,
            synced: true,
            offline: false,
            loaded: true,
            storageUnavailable: false,
            storageGone: false,
            unsyncedEdits: false,
        };
    },
}));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => ({ user: { email: 'me@example.com' } }) }));
mock.module('../../../components/cards/card-dialog', () => ({
    CardDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void }) => {
        seen.open = props.open;
        seen.onOpenChange = props.onOpenChange;
        return null;
    },
}));
// The guard blocks a leave with unsynced edits, which this canvas never has.
mock.module('../../../components/layout/app/unsynced-edits-guard', () => ({ UnsyncedEditsGuard: () => null }));
// Every request hangs, so the comment rows are what the test sets.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }),
);
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('../../../components/cards/card-dialog', () => realCardDialog);
    mock.module('../../../components/layout/app/unsynced-edits-guard', () => realGuard);
    fetchSpy.mockRestore();
    provider.destroy();
});

const { commentKeys } = await import('@workspace/lib/chat');
const { driveKeys, MediaResolverProvider } = await import('@workspace/lib/drive');
const { CanvasDocumentShell, useCanvasCommentHost, useCanvasDoc } = await import('../../../components/vector');
const { VECTOR_STYLE_DEFAULTS } = await import('@workspace/lib/vector');

const path = drivePath({ id: 'v1', mountId: 'mount', name: 'Plan.eigenvector', mimeType: 'application/eigenvector' });
const searchController: DocSearchController = {
    search: () => [],
    reveal: () => {},
    highlightAll: () => {},
};

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
    seen.open = undefined;
});

let unmount = async () => {};
afterEach(() => unmount());

let history = router.createMemoryHistory();
const chatParam = () => new URLSearchParams(history.location.search).get('chat');

// The shell and its comments host under a route that reads ?chat=, as the slide and vector routes do.
async function openCanvas(entries: string[]) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(commentKeys.list('owner', 'mount', 'v1'), []);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner', 'mount', 'v1'), []);
    function Page() {
        const { chat } = router.useSearch({ strict: false });
        const canvas = useCanvasDoc('owner', 'mount', 'v1', VECTOR_STYLE_DEFAULTS);
        const comments = useCanvasCommentHost({
            ownerId: 'owner',
            path,
            canWrite: true,
            mediaFolderId: null,
            chatFolderId: null,
            chat,
            doc: canvas,
            isMobile: false,
            onReveal: () => {},
        });
        return createElement(CanvasDocumentShell, {
            doc: canvas,
            comments,
            path,
            canWrite: true,
            canEdit: false,
            mediaFolderId: null,
            searchController,
            imagePickerOpen: false,
            onImagePickerOpenChange: () => {},
            canvasRef: { current: null },
            toolbar: null,
            propertiesPanel: null,
            children: null,
        });
    }
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({
        getParentRoute: () => root,
        path: '/',
        validateSearch: (search: Record<string, unknown>): { chat?: string } =>
            typeof search.chat === 'string' ? { chat: search.chat } : {},
        component: Page,
    });
    history = router.createMemoryHistory({ initialEntries: entries });
    const memory = router.createRouter({ routeTree: root.addChildren([page]), history });
    await memory.load();
    ({ unmount } = await renderInDocument(
        createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(MediaResolverProvider, {
                ownerId: 'owner',
                mountId: 'mount',
                mediaFolderId: null,
                chatFolderId: null,
                children: createElement(router.RouterProvider, { router: memory }),
            }),
        ),
    ));
    await settle();
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

test("a link's ?chat= opens the card, and closing it takes ?chat= out", async () => {
    await openCanvas(['/', '/?chat=thread-1.eigenchat']);
    expect(seen.open).toBe(true);
    await act(async () => seen.onOpenChange?.(false));
    await settle();
    expect(chatParam()).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
    expect(seen.open).toBe(false);
});

test('a ?chat= that names no comment is dropped by replace', async () => {
    await openCanvas(['/', '/?chat=unknown.eigenchat']);
    await settle();
    expect(chatParam()).toBeNull();
    expect(history.location.state.__TSR_index).toBe(1);
    expect(seen.open).toBeFalsy();
});
