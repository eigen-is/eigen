// The sheet editor's side of a comment: the grid's hover report drives the hover card, a card opened from the hover
// opens where the pointer already is, and one opened from the pane first jumps to its cell and gives the grid the keys,
// except on a phone, where the pane hides the grid. The grid, the pane and the card render as probes that keep their props, since they are tested
// where they live.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CommentHoverTarget } from '@workspace/lib/types/comments';
import type { Sheet } from '@workspace/sheet';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import type { ReactNode } from 'react';

installHappyDom();

type Props = Record<string, unknown>;
type GridProps = {
    ref: { current: unknown };
    toolbarRightItems: ReactNode;
    onChange: (sheets: readonly Sheet[], shown: string) => void;
    hooks: { onCommentHover: (target: CommentHoverTarget | null) => void };
};
type HoverCardProps = Props & { onOpenCard: (cardId: string) => void };
type PanelProps = { onOpenCard: (cardId: string) => void; onOpenChat: (chatName: string) => boolean };

const seen: {
    grid?: GridProps;
    hoverCard?: HoverCardProps;
    panel?: PanelProps;
    toggleComments?: () => void;
} = {};
const opened: unknown[] = [];
const workbook = {
    revealSearchMatch: (cell: unknown) => opened.push(['reveal', cell]),
    focusGrid: () => opened.push(['focus grid']),
};
const cards = { c1: { id: 'c1', title: 'One', description: '', chatName: 'chat-1' } };
const entries: never[] = [];
const hover = { target: null, report: mock(), enterCard: mock(), leaveCard: mock(), dismiss: mock() };
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
const realLayout = { ...(await import('@workspace/ui/components/layout/app')) };
const realToolbar = { ...(await import('@workspace/ui/components/layout/toolbar')) };
const realDropOverlay = { ...(await import('@workspace/ui/components/file-drop-overlay')) };
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
        props.ref.current = workbook;
        return props.toolbarRightItems;
    },
}));
mock.module('@workspace/ui/components/layout/app', () => ({
    ...realLayout,
    CollabDocumentGate: Children,
    UnsyncedEditsGuard: Nothing,
    useLayout: () => layout,
}));
mock.module('@workspace/ui/components/layout/toolbar', () => ({
    ...realToolbar,
    DocumentShareCluster: ({ onToggleCommentPanel }: { onToggleCommentPanel: () => void }) => {
        seen.toggleComments = onToggleCommentPanel;
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
    PanelColumn: (props: PanelProps) => {
        seen.panel = props;
        return null;
    },
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
    mock.module('@workspace/ui/components/layout/app', () => realLayout);
    mock.module('@workspace/ui/components/layout/toolbar', () => realToolbar);
    mock.module('@workspace/ui/components/file-drop-overlay', () => realDropOverlay);
    mock.module('@workspace/ui/components/comments', () => realUiComments);
    mock.module('@workspace/ui/components/search/doc-search-provider', () => realSearch);
    mock.module('@workspace/ui/components/cards', () => realCards);
});

const { act, createElement } = await import('react');
const { SheetEditor } = await import('../../../components/sheets/editor');

const path = drivePath({ id: 'x1', mountId: 'm1', name: 'Book.eigensheet', mimeType: 'application/eigensheet' });

// The card sits on the second tab, which is not the open one.
const FIRST_CELL = { sheetId: 's2', r: 1, c: 1 };
const tabs: Sheet[] = [
    { id: 's1', name: 'One', order: 0, data: [[null]] },
    { id: 's2', name: 'Two', order: 1, data: [[null], [null, { commentCardIds: ['c1'] }]] },
];

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    layout.isMobile = false;
    opened.length = 0;
    hover.report.mockClear();
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
    const { grid, hoverCard, toggleComments } = seen;
    if (!grid || !hoverCard || !toggleComments) throw new Error('the editor did not render');
    await act(async () => {
        grid.onChange(tabs, 's1');
        toggleComments();
    });
    if (!seen.hoverCard || !seen.panel) throw new Error('the pane did not open');
    return { grid, hoverCard: seen.hoverCard, panel: seen.panel };
}

test('a report from the grid shows the hover card on that cell, and none hides it', async () => {
    const { grid } = await renderEditor();
    const rect = new DOMRect(10, 20, 74, 20);
    grid.hooks.onCommentHover({ cardId: 'c1', rect });
    expect(hover.report).toHaveBeenLastCalledWith({ cardId: 'c1', rect });
    grid.hooks.onCommentHover(null);
    expect(hover.report).toHaveBeenLastCalledWith(null);
});

test('the hover card floats beside the cell and reads the cards the pane reads', async () => {
    const { hoverCard } = await renderEditor();
    expect(hoverCard).toMatchObject({ hover, side: 'right', cards });
    expect(hoverCard.entries).toBe(entries);
});

test('a click on the hover card opens the card and moves nothing', async () => {
    const { hoverCard } = await renderEditor();
    hoverCard.onOpenCard('c1');
    expect(opened).toEqual([['open', 'c1']]);
});

// The row took the focus, so the grid takes it back before the thread opens, which hands it back there as it closes.
test("a click on a pane row jumps to the card's first cell, gives the grid the keys, then opens the card", async () => {
    const { panel } = await renderEditor();
    panel.onOpenCard('c1');
    expect(opened).toEqual([['reveal', FIRST_CELL], ['focus grid'], ['open', 'c1']]);
});

test("a comment named by its chat, such as an activity row's, jumps too", async () => {
    const { panel } = await renderEditor();
    panel.onOpenChat('chat-1');
    expect(opened).toEqual([['reveal', FIRST_CELL], ['focus grid'], ['open', 'c1']]);
});

test('a card on no cell opens with nowhere to jump, and the grid still gets the keys', async () => {
    const { panel } = await renderEditor();
    panel.onOpenCard('c9');
    expect(opened).toEqual([['focus grid'], ['open', 'c9']]);
});

test('on a phone, where the pane hides the grid, a row and a chat name only open the card', async () => {
    layout.isMobile = true;
    const { panel } = await renderEditor();
    panel.onOpenCard('c1');
    panel.onOpenChat('chat-1');
    expect(opened).toEqual([
        ['open', 'c1'],
        ['open', 'c1'],
    ]);
});
