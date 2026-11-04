// The card dialog closes one way, however it closes. A peer who deletes the open card takes it away under the dialog,
// and that runs the same close as the user's own: the host clears its landing, and an undo that brings the card back
// doesn't open the dialog again.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { DRIVE_MIME_STICKIES } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import type { CommentContextMenuItem } from '../../../components/comments/comment-menu-items';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

// The props the card dialog was last rendered with.
const seen: { open?: boolean; onOpenChange?: (open: boolean) => void } = {};

const realAuth = { ...(await import('@workspace/lib/auth')) };
const realCardDialog = { ...(await import('../../../components/cards/card-dialog')) };
const realContextMenu = { ...(await import('../../../components/comments/comment-context-menu')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: { id: 'owner-1', email: 'ada@example.com' } }),
}));
mock.module('../../../components/cards/card-dialog', () => ({
    CardDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void }) => {
        seen.open = props.open;
        seen.onOpenChange = props.onOpenChange;
        return null;
    },
}));
mock.module('../../../components/comments/comment-context-menu', () => ({ CommentContextMenu: () => null }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('../../../components/cards/card-dialog', () => realCardDialog);
    mock.module('../../../components/comments/comment-context-menu', () => realContextMenu);
});

// A comments fetch that never answers, so the rows are what the test sets.
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }),
);
afterAll(() => fetchSpy.mockRestore());

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { commentKeys } = await import('@workspace/lib/chat');
const { driveKeys } = await import('@workspace/lib/drive');
const { useCommentLifecycle } = await import('@workspace/lib/comments');
const { useContextMenu } = await import('../../../components/context-menu');
const { CommentLifecycleDialogs } = await import('../../../components/comments/comment-lifecycle-dialogs');

const path = drivePath({
    id: 'board-1',
    mountId: 'm1',
    name: 'Board',
    type: 'stickies',
    mimeType: DRIVE_MIME_STICKIES,
});

function addCard(doc: Y.Doc): void {
    const card = new Y.Map<unknown>();
    card.set('title', 'Ship it');
    card.set('description', '');
    card.set('chatName', 'ship.eigenchat');
    doc.getMap('tasks').set('card-1', card);
}

let unmount = async () => {};
afterEach(() => unmount());

async function mountBoard() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queryClient.setQueryData(commentKeys.list('owner-1', 'm1', 'board-1'), []);
    queryClient.setQueryData(driveKeys.effectiveMembers('owner-1', 'm1', 'board-1'), []);
    const doc = new Y.Doc();
    addCard(doc);
    const onCardDialogClose = mock(() => {});
    const handle: { setOpenCardId?: (cardId: string | null) => void } = {};
    function Harness() {
        const lifecycle = useCommentLifecycle({
            ownerId: 'owner-1',
            mountId: 'm1',
            pathId: 'board-1',
            chatFolderId: 'chat-1',
            mediaFolderId: null,
            doc,
            activeCardIds: new Set(['card-1']),
            mapName: 'tasks',
            ready: true,
        });
        handle.setOpenCardId = lifecycle.setOpenCardId;
        const commentContextMenu = useContextMenu<CommentContextMenuItem>();
        return createElement(CommentLifecycleDialogs, {
            lifecycle,
            path,
            canWrite: true,
            commentContextMenu,
            onDelete: () => {},
            onCardDialogClose,
        });
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)));
    });
    unmount = async () => act(() => root.unmount());
    await act(async () => handle.setOpenCardId?.('card-1'));
    return { doc, onCardDialogClose };
}

test("a peer's delete closes the dialog as the user's close does, and an undo doesn't reopen it", async () => {
    const { doc, onCardDialogClose } = await mountBoard();
    expect(seen.open).toBe(true);

    await act(async () => {
        doc.getMap('tasks').delete('card-1');
    });
    expect(seen.open).toBe(false);
    expect(onCardDialogClose).toHaveBeenCalledTimes(1);

    await act(async () => addCard(doc));
    expect(seen.open).toBe(false);
});

test("the user's close runs the host's close once", async () => {
    const { onCardDialogClose } = await mountBoard();
    await act(async () => seen.onOpenChange?.(false));
    expect(seen.open).toBe(false);
    expect(onCardDialogClose).toHaveBeenCalledTimes(1);
});
