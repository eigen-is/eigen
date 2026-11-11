// Resting the pointer on a comment mark shows the card, and only the mark does: the canvas reports where the mark is
// and when the pointer leaves, a press opens the thread without a hover card over it, and the shell both canvas apps
// render through draws the card the host's hover names, whose click runs the opener the mark uses. Its image picker is
// titled Insert image, as in Docs and Sheets.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard, CommentHoverTarget } from '@workspace/lib/types/comments';
import type { DocSearchController } from '@workspace/lib/types/doc-search';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useRef, useState } = await import('react');
const realCollab = await import('@workspace/lib/collab');
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realComments = { ...(await import('@workspace/lib/comments')) };
const realDialogs = { ...(await import('../../../components/comments/comment-lifecycle-dialogs')) };
const realGuard = { ...(await import('../../../components/layout/app/unsynced-edits-guard')) };
const realBrowser = { ...(await import('../../../components/drive/drive-browser')) };
const { MediaResolverProvider } = await import('@workspace/lib/drive');
const { generateNKeysBetween, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import('@workspace/lib/vector');
type UseCollabDocOptions = Parameters<typeof realCollab.useCollabDoc>[0];

const CARD: CommentCard = { id: 'card-1', title: 'The title', description: '<p>The note</p>' };
const cards: Record<string, CommentCard> = { 'card-1': CARD };
const entries: CommentEntry[] = [];
const RECT = new DOMRect(100, 200, 10, 20);
const setOpenCardId = mock((_cardId: string) => {});

let doc = new Y.Doc();
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: (options: UseCollabDocOptions) => {
        const docRef = useRef(doc);
        const onInit = useRef(options.onInit);
        useEffect(() => onInit.current?.({ doc, provider, undoManager: null }), []);
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
mock.module('@workspace/lib/comments', () => ({
    ...realComments,
    useCommentLifecycle: () => ({
        allComments: entries,
        cards,
        createCard: async () => null,
        assignComment: { mutate: () => {} },
        members: [],
        assignedCount: 0,
        setOpenCardId,
        openChat: () => {},
        isCardDeleted: () => false,
    }),
}));
mock.module('../../../components/comments/comment-lifecycle-dialogs', () => ({
    CommentLifecycleDialogs: () => null,
}));
// The guard asks the router, which a test of the shell's comments has no need of.
mock.module('../../../components/layout/app/unsynced-edits-guard', () => ({ UnsyncedEditsGuard: () => null }));
// The picker's folder listing fetches Drive; only its title is under test.
mock.module('../../../components/drive/drive-browser', () => ({ DriveBrowser: () => null }));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/comments', () => realComments);
    mock.module('../../../components/comments/comment-lifecycle-dialogs', () => realDialogs);
    mock.module('../../../components/layout/app/unsynced-edits-guard', () => realGuard);
    mock.module('../../../components/drive/drive-browser', () => realBrowser);
    provider.destroy();
});

const { CanvasDocumentShell, CanvasEditor, useCanvasCommentHost, useCanvasDoc } = await import(
    '../../../components/vector'
);

// happy-dom lays nothing out, so with a viewport of no size floating-ui would flip the card to the other side.
Object.defineProperty(document.documentElement, 'clientWidth', { value: 1024 });
Object.defineProperty(document.documentElement, 'clientHeight', { value: 768 });

const path = drivePath({ id: 'v1', mountId: 'mount', name: 'Plan.eigenvector', mimeType: 'application/eigenvector' });
const searchController: DocSearchController = {
    search: () => [],
    reveal: () => {},
    highlightAll: () => {},
};

beforeEach(() => {
    setOpenCardId.mockClear();
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    const [key] = generateNKeysBetween(null, null, 1);
    writeElementInDoc(
        doc,
        { type: 'rectangle', x: 0, y: 0, width: 100, height: 100, commentCardIds: '["card-1"]' },
        key,
        VECTOR_STYLE_DEFAULTS,
        'box',
    );
});

let unmount = async () => {};
afterEach(() => unmount());

const canvasProps = {
    viewport: 'infinite' as const,
    styleDefaults: VECTOR_STYLE_DEFAULTS,
    tool: 'select' as const,
    setTool: () => {},
    toolLocked: false,
    setToolLocked: () => {},
    canEdit: true,
    ownerId: 'owner',
    mountId: 'mount',
    fileName: 'Plan',
    selectedIds: [],
    setSelectedIds: () => {},
    toggle: () => {},
    aspectLocked: false,
    publishCursor: () => {},
    canvasRef: { current: null },
    onTextEditingChange: () => {},
    commentCards: cards,
};

function inResolver(children: React.ReactNode) {
    return createElement(MediaResolverProvider, {
        ownerId: 'owner',
        mountId: 'mount',
        mediaFolderId: null,
        chatFolderId: null,
        children,
    });
}

// The canvas alone, with its two comment callbacks writing to one log, so their order shows.
async function renderCanvas() {
    const log: unknown[] = [];
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        return createElement(CanvasEditor, {
            ...canvasProps,
            doc: canvas,
            onOpenCard: (cardId: string) => log.push(`open ${cardId}`),
            onCommentHover: (target: CommentHoverTarget | null) => log.push(target),
        });
    }
    ({ unmount } = await renderInDocument(inResolver(createElement(Host))));
    await act(async () => {});
    return log;
}

// The whole wiring as an app mounts it: the real host and the real shell around the real canvas.
async function renderShell({
    mediaFolderId = null,
    pickerOpen = false,
}: {
    mediaFolderId?: string | null;
    pickerOpen?: boolean;
} = {}) {
    const reveal = mock((_elementId: string) => {});
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        const [imagePickerOpen, setImagePickerOpen] = useState(pickerOpen);
        const comments = useCanvasCommentHost({
            ownerId: 'owner',
            path,
            canWrite: true,
            mediaFolderId: null,
            chatFolderId: null,
            doc: canvas,
            isMobile: false,
            onReveal: (el) => reveal(el.id),
        });
        return createElement(CanvasDocumentShell, {
            doc: canvas,
            comments,
            path,
            canWrite: true,
            canEdit: false,
            mediaFolderId,
            searchController,
            imagePickerOpen,
            onImagePickerOpenChange: setImagePickerOpen,
            canvasRef: { current: null },
            toolbar: null,
            propertiesPanel: null,
            children: createElement(CanvasEditor, {
                ...canvasProps,
                doc: canvas,
                onOpenCard: comments.openCard,
                onCommentHover: comments.onCommentHover,
            }),
        });
    }
    ({ unmount } = await renderInDocument(inResolver(createElement(Host))));
    await act(async () => {});
    return reveal;
}

function theMark() {
    const mark = document.querySelector<HTMLButtonElement>('button[aria-label="Open comment"]');
    if (!mark) throw new Error('no comment mark');
    mark.getBoundingClientRect = () => RECT;
    return mark;
}

const send = (element: Element, type: string) =>
    act(async () => {
        element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    });
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const hoverCard = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]');

test('the pointer entering a mark reports its card and where it is', async () => {
    const log = await renderCanvas();
    await send(theMark(), 'pointerover');
    expect(log).toEqual([{ cardId: 'card-1', rect: RECT }]);
});

test('the pointer leaving a mark reports null', async () => {
    const log = await renderCanvas();
    const mark = theMark();
    await send(mark, 'pointerover');
    await send(mark, 'pointerout');
    expect(log).toEqual([{ cardId: 'card-1', rect: RECT }, null]);
});

test('a mark that goes under the pointer reports null, as no pointer leave comes', async () => {
    const log = await renderCanvas();
    await send(theMark(), 'pointerover');
    await act(async () => doc.getMap('elements').delete('box'));
    expect(log).toEqual([{ cardId: 'card-1', rect: RECT }, null]);
});

test('a mark that goes elsewhere leaves the hover alone', async () => {
    const log = await renderCanvas();
    await act(async () => doc.getMap('elements').delete('box'));
    expect(log).toEqual([]);
});

test('a press reports null before it opens the thread', async () => {
    const log = await renderCanvas();
    await send(theMark(), 'pointerdown');
    expect(log).toEqual([null, 'open card-1']);
});

test('the mark has no native tooltip to race the card', async () => {
    await renderCanvas();
    expect(theMark().hasAttribute('title')).toBe(false);
    expect(theMark().getAttribute('aria-label')).toBe('Open comment');
});

test('the element itself is no trigger: only the mark reports', async () => {
    const log = await renderCanvas();
    const canvas = theMark().closest('[tabindex="-1"]');
    if (!canvas) throw new Error('no canvas');
    await send(canvas, 'pointerover');
    expect(log).toEqual([]);
});

test('the shell shows the card beside the mark after the pause', async () => {
    await renderShell();
    await send(theMark(), 'pointerover');
    expect(hoverCard()).toBeNull();
    await wait(350);
    expect(hoverCard()?.textContent).toContain('The title');
    expect(hoverCard()?.getAttribute('data-side')).toBe('right');
});

test('a press within the pause opens no card over the thread', async () => {
    await renderShell();
    const mark = theMark();
    await send(mark, 'pointerover');
    await send(mark, 'pointerdown');
    await wait(350);
    expect(setOpenCardId).toHaveBeenCalledWith('card-1');
    expect(hoverCard()).toBeNull();
});

test('leaving the mark closes the card after the grace', async () => {
    await renderShell();
    const mark = theMark();
    await send(mark, 'pointerover');
    await wait(350);
    await send(mark, 'pointerout');
    await wait(200);
    expect(hoverCard()).toBeNull();
});

test('a mark that goes within the pause opens no card', async () => {
    await renderShell();
    await send(theMark(), 'pointerover');
    await act(async () => doc.getMap('elements').delete('box'));
    await wait(350);
    expect(hoverCard()).toBeNull();
});

test('a click on the card opens it as the mark does, revealing its element', async () => {
    const reveal = await renderShell();
    await send(theMark(), 'pointerover');
    await wait(350);
    const note = hoverCard()?.querySelector<HTMLElement>('.cursor-pointer');
    if (!note) throw new Error('no card to click');
    await act(async () => note.click());
    expect(reveal).toHaveBeenCalledWith('box');
    expect(setOpenCardId).toHaveBeenCalledWith('card-1');
    expect(hoverCard()).toBeNull();
});

test('the image picker is titled Insert image', async () => {
    await renderShell({ mediaFolderId: 'media', pickerOpen: true });
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Insert image');
});
