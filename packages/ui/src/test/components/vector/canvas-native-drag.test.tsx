// A press on the canvas is the canvas' gesture. With a text run selected over the scene's text boxes, Safari starts
// its own drag of that run on any press, and Chrome does so over selectable text: the page then gets no pointerup,
// shows the run as a ghost image and the shape never moves. So the canvas cancels every dragstart but a text editor's.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useRef, useState } = await import('react');
const realCollab = await import('@workspace/lib/collab');
const { MediaResolverProvider } = await import('@workspace/lib/drive');
const { generateNKeysBetween, readVectorFromDoc, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import(
    '@workspace/lib/vector'
);
type NewVectorElement = import('@workspace/lib/vector').NewVectorElement;
type UseCollabDocOptions = Parameters<typeof realCollab.useCollabDoc>[0];

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
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    provider.destroy();
});

const { CanvasEditor, useCanvasDoc } = await import('../../../components/vector');

// A bar with a label's text box stacked over it, as Convert to shapes leaves a chart.
const ELEMENTS: (NewVectorElement & { id: string })[] = [
    { id: 'bar', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
    { id: 'label', type: 'richtext', x: 0, y: 40, width: 300, height: 40, html: '<p>Sun</p>', fontFamily: 'Inter' },
];

beforeEach(() => {
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    const keys = generateNKeysBetween(null, null, ELEMENTS.length);
    for (const [i, { id, ...partial }] of ELEMENTS.entries()) {
        writeElementInDoc(doc, partial, keys[i], VECTOR_STYLE_DEFAULTS, id);
    }
});

let unmount = async () => {};
afterEach(() => unmount());

let container: HTMLElement;

async function render() {
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        const [selectedIds, setSelectedIds] = useState<string[]>([]);
        return createElement(CanvasEditor, {
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
        });
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
    container = rendered.container;
    await act(async () => {});
}

function layer(id: string): HTMLElement {
    const node = container.querySelector<HTMLElement>(`[data-element-id="${id}"]`);
    if (!node) throw new Error(`no layer ${id}`);
    return node;
}

// The browser's own drag, as it starts from a node in the scene: true when the canvas let it run.
function nativeDragFrom(node: Node): boolean {
    return node.dispatchEvent(new window.Event('dragstart', { bubbles: true, cancelable: true }));
}

function pointer(type: string, clientX: number, clientY: number) {
    return new window.PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX,
        clientY,
    });
}

const barX = () => readVectorFromDoc(doc).elements.find((el) => el.id === 'bar')?.x;

test("a drag the browser starts from a text box's text is canceled", async () => {
    await render();
    const text = layer('label').querySelector('p')?.firstChild;
    if (!text) throw new Error('no label text');
    expect(nativeDragFrom(text)).toBe(false);
    expect(nativeDragFrom(layer('bar'))).toBe(false);
});

// The browser's side, as Chrome and Safari behave: a drag the page lets run takes the pointer, so the gesture
// that started it ends canceled where it began.
async function dragBar(from: Node) {
    const surface = container.querySelector('.origin-top-left')?.parentElement;
    if (!surface) throw new Error('no canvas');
    // One act per event, as the browser delivers them: the release reads the move's rendered preview.
    await act(async () => surface.dispatchEvent(pointer('pointerdown', 50, 20)));
    if (nativeDragFrom(from)) {
        await act(async () => surface.dispatchEvent(pointer('pointercancel', 50, 20)));
        return;
    }
    await act(async () => surface.dispatchEvent(pointer('pointermove', 80, 40)));
    await act(async () => surface.dispatchEvent(pointer('pointerup', 80, 40)));
}

test("a press on a bar moves it while a text box's selected text lies over the scene", async () => {
    await render();
    const text = layer('label').querySelector('p')?.firstChild;
    if (!text) throw new Error('no label text');
    await dragBar(text);
    expect(barX()).toBe(30);
});

test("a drag inside a text box being edited stays the browser's", async () => {
    await render();
    await act(async () => {
        layer('label').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, clientX: 150, clientY: 60 }));
    });
    const editable = layer('label').querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editable) throw new Error('no editor');
    editable.focus();
    expect(nativeDragFrom(editable)).toBe(true);
});
