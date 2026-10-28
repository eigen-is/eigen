// The vector editor decides who edits the scene: a writer on a wide screen edits, a phone only views, and
// a reader never edits. Adding an image needs the media folder and a comment needs the chat folder. A
// reveal selects the element and centers the infinite canvas on it, and the empty selection's panel sets
// the scene's background.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { VectorElement } from '@workspace/lib/vector';
import { drivePath } from '@workspace/ui/test/drive-path';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import type { ReactNode } from 'react';

installHappyDom();

// The props each part of the shell was last rendered with, read by the tests below.
type Props = Record<string, unknown>;
const seen: { shell?: Props; toolbar?: Props; canvas?: Props; panel?: Props; comments?: Props; docArgs?: unknown[] } =
    {};
const layout = { isMobile: false };
const centerOn = mock((_el: VectorElement) => {});
const updateMeta = mock((_meta: { background: string | null }) => {});
// One object per hook, so the editor's memos and effects see stable values.
const doc = {
    elements: [],
    frames: [],
    meta: { background: null },
    provider: null,
    offline: false,
    storageUnavailable: false,
    undoManager: null,
    updateElements: () => {},
    reorderElements: () => {},
    replaceElement: () => {},
    updateMeta,
};
const comments = {
    toggleComments: () => {},
    commentPanelOpen: false,
    assignedCount: 0,
    toggleActivity: () => {},
    activityPanelOpen: false,
    openCard: () => {},
    lifecycle: { cards: [] },
    addCommentTo: () => {},
};
const search = { controller: null, matchedIds: [], activeId: null };

// The canvas, its toolbar and panels are shared with Slides and tested there, so they render as probes
// that keep their props. Copies, because mock.module rewrites a loaded module's exports in place.
const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realVector = { ...(await import('@workspace/ui/components/vector')) };
const realUi = { ...(await import('@workspace/ui')) };
const realPanel = { ...(await import('@workspace/ui/components/properties-panel')) };
mock.module('@workspace/ui/components/vector', () => ({
    ...realVector,
    useCanvasDoc: (...args: unknown[]) => {
        seen.docArgs = args;
        return doc;
    },
    useCanvasPresence: () => () => {},
    useCanvasCommentHost: (props: Props) => {
        seen.comments = props;
        return comments;
    },
    useCanvasDocSearch: () => search,
    CanvasDocumentShell: (props: Props & { toolbar: ReactNode; propertiesPanel: ReactNode; children: ReactNode }) => {
        seen.shell = props;
        return (
            <>
                {props.toolbar}
                {props.propertiesPanel}
                {props.children}
            </>
        );
    },
    CanvasToolbar: (props: Props) => {
        seen.toolbar = props;
        return null;
    },
    CanvasEditor: (props: Props & { canvasRef: { current: unknown } }) => {
        seen.canvas = props;
        props.canvasRef.current = { centerOn };
        return null;
    },
    CanvasPropertiesPanel: (props: Props & { emptySection: ReactNode }) => {
        seen.panel = props;
        return props.emptySection;
    },
}));
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/ui', () => ({ ...realUi, useLayout: () => layout }));
mock.module('@workspace/ui/components/properties-panel', () => ({
    ...realPanel,
    ColorRow: ({ label, onChange }: { label: string; onChange: (color: string | null) => void }) => (
        <>
            <button type="button" onClick={() => onChange('#ff0000')}>
                {`${label}: red`}
            </button>
            <button type="button" onClick={() => onChange(null)}>
                {`${label}: none`}
            </button>
        </>
    ),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/ui/components/vector', () => realVector);
    mock.module('@workspace/ui', () => realUi);
    mock.module('@workspace/ui/components/properties-panel', () => realPanel);
});

const { act, createElement } = await import('react');
const { VECTOR_STYLE_DEFAULTS } = await import('@workspace/lib/vector');
const { VectorEditor } = await import('../../../components/vector/editor');

const path = drivePath({ id: 'v1', mountId: 'm1', name: 'Logo.eigenvector', mimeType: 'application/eigenvector' });

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    layout.isMobile = false;
    centerOn.mockClear();
    updateMeta.mockClear();
});

async function renderEditor(options: {
    canWrite?: boolean;
    mediaFolderId?: string | null;
    chatFolderId?: string | null;
}) {
    ({ unmount } = await renderInDocument(
        createElement(VectorEditor, {
            ownerId: 'owner-1',
            path,
            canWrite: options.canWrite ?? true,
            mediaFolderId: options.mediaFolderId === undefined ? 'media-1' : options.mediaFolderId,
            chatFolderId: options.chatFolderId === undefined ? 'chat-1' : options.chatFolderId,
            onAccessDialogOpen: () => {},
        }),
    ));
}

const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;

test('a writer on a wide screen edits an infinite canvas with the vector style defaults', async () => {
    await renderEditor({});
    expect(seen.docArgs).toEqual(['owner-1', 'm1', 'v1', VECTOR_STYLE_DEFAULTS]);
    expect(seen.canvas).toMatchObject({ canEdit: true, viewport: 'infinite', styleDefaults: VECTOR_STYLE_DEFAULTS });
    expect(seen.shell).toMatchObject({ canWrite: true, canEdit: true });
    expect(seen.toolbar).toMatchObject({ canEdit: true, createLabel: 'New vector', createType: 'vector' });
});

test('on a phone a writer only views the scene, but keeps the rights that are not editing', async () => {
    layout.isMobile = true;
    await renderEditor({});
    expect(seen.canvas?.canEdit).toBe(false);
    expect(seen.toolbar).toMatchObject({ canWrite: true, canEdit: false, onInsertImage: undefined });
    expect(seen.shell).toMatchObject({ canWrite: true, canEdit: false });
});

test('a reader never edits, and adds no comment', async () => {
    await renderEditor({ canWrite: false });
    expect(seen.canvas).toMatchObject({ canEdit: false, onAddComment: undefined });
});

test('an image is offered only with a media folder, and opens the picker', async () => {
    await renderEditor({ mediaFolderId: null });
    expect(seen.toolbar?.onInsertImage).toBeUndefined();
    await unmount();

    await renderEditor({});
    const insert = seen.toolbar?.onInsertImage;
    if (typeof insert !== 'function') throw new Error('a writer with a media folder is offered no image');
    expect(seen.shell?.imagePickerOpen).toBe(false);
    await act(async () => insert());
    expect(seen.shell?.imagePickerOpen).toBe(true);
});

test('a comment needs the chat folder', async () => {
    await renderEditor({ chatFolderId: null });
    expect(seen.canvas?.onAddComment).toBeUndefined();
    await unmount();

    await renderEditor({});
    expect(seen.canvas?.onAddComment).toBe(comments.addCommentTo);
});

test('a reveal selects the element and centers the canvas on it', async () => {
    await renderEditor({});
    const reveal = seen.comments?.onReveal;
    if (typeof reveal !== 'function') throw new Error('the comments host gets no reveal');
    const element = { id: 'shape-7' };
    await act(async () => reveal(element));
    expect(seen.canvas?.selectedIds).toEqual(['shape-7']);
    expect(centerOn).toHaveBeenCalledWith(element);
});

test("the empty selection's Background sets the scene's color, and None clears it", async () => {
    await renderEditor({});
    await act(async () => button('Color: red')?.click());
    await act(async () => button('Color: none')?.click());
    expect(updateMeta.mock.calls).toEqual([[{ background: '#ff0000' }], [{ background: null }]]);
});
