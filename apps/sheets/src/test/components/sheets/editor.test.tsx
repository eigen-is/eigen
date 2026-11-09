// The sheet editor's side of a comment: the grid's hover report drives the hover card, and a card opened from the hover
// opens where the pointer already is. The grid, the pane and the card render as probes that keep their props, since
// they are tested where they live.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CommentHoverTarget } from '@workspace/lib/types/comments';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import type { ReactNode } from 'react';

installHappyDom();

type Props = Record<string, unknown>;
type GridProps = {
    hooks: { onCommentHover: (target: CommentHoverTarget | null) => void };
};
type HoverCardProps = Props & { onOpenCard: (cardId: string) => void };

const seen: { grid?: GridProps; hoverCard?: HoverCardProps } = {};
const opened: unknown[] = [];
const cards = { c1: { id: 'c1', title: 'One', description: '', chatName: 'chat-1' } };
const entries: never[] = [];
const hover = { target: null, show: mock(), hide: mock(), enterCard: mock(), leaveCard: mock(), dismiss: mock() };
const lifecycle = {
    allComments: entries,
    cards,
    createCard: () => {},
    assignComment: {},
    members: [],
    assignedCount: 0,
    isCardDeleted: () => false,
    setOpenCardId: (cardId: string | null) => opened.push(['open', cardId]),
    openChat: (_chatName: string, openCard?: (cardId: string) => void) => {
        if (openCard) openCard('c1');
        else opened.push(['open', 'c1']);
        return true;
    },
};
const sheet = {
    initialData: [{ id: 's1', name: 'One', order: 0 }],
    snapshotVersion: 0,
    loadFailed: false,
    synced: true,
    offline: false,
    loaded: true,
    storageUnavailable: false,
    storageGone: false,
    unsyncedEdits: false,
    handleOp: () => {},
    docRef: { current: null },
    provider: null,
};
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const layout = { isMobile: false };

// Copies, because mock.module rewrites a loaded module's exports in place.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realComments = { ...(await import('@workspace/lib/comments')) };
const realDrive = { ...(await import('@workspace/lib/drive')) };
const realSheet = { ...(await import('@workspace/sheet')) };
const realUi = { ...(await import('@workspace/ui')) };
const realUiComments = { ...(await import('@workspace/ui/components/comments')) };
const realSearch = { ...(await import('@workspace/ui/components/search/doc-search-provider')) };
const realCards = { ...(await import('@workspace/ui/components/cards')) };

const Children = ({ children }: { children?: ReactNode }) => children;
const Nothing = () => null;
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/comments', () => ({
    ...realComments,
    useCommentLifecycle: () => lifecycle,
    useCommentHover: () => hover,
}));
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useCopyToMediaFolder: () => ({ mutateAsync: () => {} }),
    useUploadFile: () => ({ mutateAsync: () => {} }),
    useMediaResolver: () => ({ resolveMediaUrlByPath: () => '', startUpload: () => {} }),
    useZombieMediaSweep: () => {},
}));
mock.module('@workspace/sheet', () => ({
    ...realSheet,
    Workbook: (props: GridProps) => {
        seen.grid = props;
        return null;
    },
}));
mock.module('@workspace/ui', () => ({
    ...realUi,
    CollabDocumentGate: Children,
    DocumentShareCluster: Nothing,
    FileDropOverlay: Nothing,
    UnsyncedEditsGuard: Nothing,
    useLayout: () => layout,
}));
mock.module('@workspace/ui/components/comments', () => ({
    ...realUiComments,
    CommentHoverCard: (props: HoverCardProps) => {
        seen.hoverCard = props;
        return null;
    },
    CommentLifecycleDialogs: Nothing,
    PanelColumn: Nothing,
}));
mock.module('@workspace/ui/components/search/doc-search-provider', () => ({
    ...realSearch,
    DocSearchProvider: Children,
}));
mock.module('@workspace/ui/components/cards', () => ({ ...realCards, CardFormDialog: Nothing }));
mock.module('../../../components/sheets/hooks/use-sheet', () => ({ useSheet: () => sheet }));
mock.module('../../../components/sheets/hooks/use-presence', () => ({ usePresence: () => () => {} }));
mock.module('../../../components/sheets/hooks/use-search-controller', () => ({
    useSheetSearchController: () => null,
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/comments', () => realComments);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/sheet', () => realSheet);
    mock.module('@workspace/ui', () => realUi);
    mock.module('@workspace/ui/components/comments', () => realUiComments);
    mock.module('@workspace/ui/components/search/doc-search-provider', () => realSearch);
    mock.module('@workspace/ui/components/cards', () => realCards);
});

const { createElement } = await import('react');
const { SheetEditor } = await import('../../../components/sheets/editor');

const path = drivePath({ id: 'x1', mountId: 'm1', name: 'Book.eigensheet', mimeType: 'application/eigensheet' });

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    layout.isMobile = false;
    opened.length = 0;
    hover.show.mockClear();
    hover.hide.mockClear();
});

async function renderEditor() {
    ({ unmount } = await renderInDocument(
        createElement(SheetEditor, {
            ownerId: 'owner-1',
            path,
            canWrite: true,
            mediaFolderId: null,
            chatFolderId: 'chat-1',
            onAccessDialogOpen: () => {},
        }),
    ));
    const { grid, hoverCard } = seen;
    if (!grid || !hoverCard) throw new Error('the editor did not render');
    return { grid, hoverCard };
}

test('a report from the grid shows the hover card on that cell, and none hides it', async () => {
    const { grid } = await renderEditor();
    const rect = new DOMRect(10, 20, 74, 20);
    grid.hooks.onCommentHover({ cardId: 'c1', rect });
    expect(hover.show).toHaveBeenCalledWith('c1', rect);
    expect(hover.hide).not.toHaveBeenCalled();
    grid.hooks.onCommentHover(null);
    expect(hover.hide).toHaveBeenCalledTimes(1);
});

test('the hover card floats beside the cell and reads the cards the pane reads', async () => {
    const { hoverCard } = await renderEditor();
    expect(hoverCard).toMatchObject({ hover, side: 'right', cards });
    expect(hoverCard.entries).toBe(entries);
});

test('a click on the hover card opens the card', async () => {
    const { hoverCard } = await renderEditor();
    hoverCard.onOpenCard('c1');
    expect(opened).toEqual([['open', 'c1']]);
});
