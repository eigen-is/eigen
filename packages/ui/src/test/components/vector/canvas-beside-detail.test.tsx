// A canvas beside a detail column, such as a comment thread: while the focus sits in the column, the canvas's keys stand
// down, so Delete on its button keeps the selected element and ⌘Z in its reply box undoes nothing on the canvas. Esc
// goes to the canvas first: one it uses to deselect leaves the column open for the next, and with nothing to cancel the
// column closes at once.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, Fragment, useEffect, useRef, useState } = await import('react');
const realCollab = await import('@workspace/lib/collab');
const { MediaResolverProvider } = await import('@workspace/lib/drive');
const { generateNKeysBetween, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import('@workspace/lib/vector');
type UseCollabDocOptions = Parameters<typeof realCollab.useCollabDoc>[0];

let doc = new Y.Doc();
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
let undoManager = new Y.UndoManager(doc.getMap('elements'));
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: (options: UseCollabDocOptions) => {
        const docRef = useRef(doc);
        const onInit = useRef(options.onInit);
        useEffect(() => onInit.current?.({ doc, provider, undoManager }), []);
        return {
            doc,
            docRef,
            provider,
            undoManager,
            synced: true,
            offline: false,
            loaded: true,
            storageUnavailable: false,
            storageGone: false,
            unsyncedEdits: false,
        };
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    provider.destroy();
});

const { CanvasEditor, useCanvasDoc } = await import('../../../components/vector');
const { DetailColumn } = await import('../../../components/layout/app/detail-column');

const MOD = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

beforeEach(() => {
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    undoManager = new Y.UndoManager(doc.getMap('elements'));
    const [key] = generateNKeysBetween(null, null, 1);
    writeElementInDoc(
        doc,
        { type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
        key,
        VECTOR_STYLE_DEFAULTS,
        'box',
    );
    // Each write its own step, and the seed none.
    undoManager.captureTimeout = 0;
    undoManager.clear();
    closes = 0;
});

let unmount = async () => {};
afterEach(() => unmount());

let selection: string[] = [];
let closes = 0;

async function render(selected: string[]) {
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        const [selectedIds, setSelectedIds] = useState(selected);
        selection = selectedIds;
        return createElement(
            Fragment,
            null,
            createElement(CanvasEditor, {
                onCommentHover: () => {},
                doc: canvas,
                viewport: 'infinite',
                styleDefaults: VECTOR_STYLE_DEFAULTS,
                tool: 'select',
                setTool: () => {},
                toolLocked: false,
                setToolLocked: () => {},
                canEdit: true,
                ownerId: 'owner',
                mountId: 'mount',
                fileName: 'Plan',
                selectedIds,
                setSelectedIds,
                toggle: () => {},
                aspectLocked: false,
                publishCursor: () => {},
                canvasRef: { current: null },
                onTextEditingChange: () => {},
            }),
            createElement(DetailColumn, {
                width: 'large',
                actions: createElement('button', { type: 'button' }, 'Resolve'),
                onClose: () => closes++,
                children: createElement('textarea', { 'aria-label': 'Reply' }),
            }),
        );
    }
    const rendered = await renderInDocument(
        createElement(MediaResolverProvider, {
            ownerId: 'owner',
            mountId: 'mount',
            mediaFolderId: 'media',
            chatFolderId: null,
            children: createElement(Host),
        }),
    );
    unmount = rendered.unmount;
    await act(async () => {});
}

const elementCount = () => doc.getMap('elements').size;

async function press(target: EventTarget, init: KeyboardEventInit) {
    await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });
}

async function focus(selector: string) {
    const element = [...document.querySelectorAll<HTMLElement>(selector)].at(-1);
    if (!element) throw new Error(`nothing matches ${selector}`);
    await act(async () => element.focus());
    return element;
}

test("Delete on the column's button keeps the selected element", async () => {
    await render(['box']);
    const resolve = await focus('[data-slot="detail-column"] button');
    await press(resolve, { key: 'Delete', code: 'Delete' });
    expect(elementCount()).toBe(1);
});

test('⌘Z in the reply box undoes nothing on the canvas', async () => {
    await render([]);
    await act(async () => doc.getMap('elements').delete('box'));
    expect(elementCount()).toBe(0);
    const reply = await focus('textarea[aria-label="Reply"]');
    await press(reply, { key: 'z', code: 'KeyZ', ...MOD });
    expect(elementCount()).toBe(0);
});

test('an Esc that deselects keeps the column open, and the next one closes it', async () => {
    await render(['box']);
    await press(document.body, { key: 'Escape' });
    expect(selection).toEqual([]);
    expect(closes).toBe(0);
    await press(document.body, { key: 'Escape' });
    expect(closes).toBe(1);
});

test('with nothing selected Esc closes the column at once', async () => {
    await render([]);
    await press(document.body, { key: 'Escape' });
    expect(closes).toBe(1);
});
