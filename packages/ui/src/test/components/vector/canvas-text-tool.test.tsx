// The Text tool places a text box: a rectangle that fits its text. An empty one is gone once its editor closes, where an
// empty rectangle the user drew stays, painted or not.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useRef, useState } = await import('react');
const realCollab = await import('@workspace/lib/collab');
const { MediaResolverProvider } = await import('@workspace/lib/drive');
const { NEW_TEXT_BOX_SIZE, readVectorFromDoc, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import(
    '@workspace/lib/vector'
);
type VectorTool = import('../../../components/vector/hooks/use-tool').VectorTool;
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

beforeEach(() => {
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
});

let unmount = async () => {};
afterEach(() => unmount());

let container: HTMLElement;

async function render(tool: VectorTool) {
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        const [selectedIds, setSelectedIds] = useState<string[]>([]);
        return createElement(CanvasEditor, {
            doc: canvas,
            viewport: 'infinite',
            styleDefaults: VECTOR_STYLE_DEFAULTS,
            tool,
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

function surface(): HTMLElement {
    const found = container.querySelector('.origin-top-left')?.parentElement;
    if (!found) throw new Error('no canvas');
    return found;
}

async function pointer(type: string, clientX: number, clientY: number) {
    await act(async () =>
        surface().dispatchEvent(
            new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX, clientY }),
        ),
    );
}

async function click(clientX: number, clientY: number) {
    await pointer('pointerdown', clientX, clientY);
    await pointer('pointerup', clientX, clientY);
}

async function doubleClick(clientX: number, clientY: number) {
    await act(async () =>
        surface().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX, clientY })),
    );
}

const editorOpen = () => container.querySelector('[contenteditable="true"]') !== null;
const elements = () => readVectorFromDoc(doc).elements;

test('a click with the Text tool places an empty text box and opens its editor', async () => {
    await render('text');
    await click(200, 200);
    expect(elements()).toEqual([
        expect.objectContaining({
            type: 'rectangle',
            autoFit: true,
            ...NEW_TEXT_BOX_SIZE,
            html: '',
            textAlign: 'left',
            verticalAlign: 'top',
            padding: 0,
            strokeColor: 'transparent',
        }),
    ]);
    expect(editorOpen()).toBe(true);

    // A press outside the box closes the editor, and the box with no text is gone.
    await click(900, 900);
    expect(elements()).toEqual([]);
});

test('a drag with the Text tool commits a text box of the dragged size and opens its editor', async () => {
    await render('text');
    await pointer('pointerdown', 200, 200);
    await pointer('pointermove', 400, 260);
    await pointer('pointermove', 500, 350);
    await pointer('pointerup', 500, 350);
    expect(elements()).toEqual([
        expect.objectContaining({
            type: 'rectangle',
            autoFit: true,
            width: 300,
            height: 150,
            strokeColor: 'transparent',
        }),
    ]);
    expect(editorOpen()).toBe(true);
});

test('a double-click on empty canvas opens a new text box there', async () => {
    await render('select');
    await doubleClick(200, 200);
    expect(elements()).toEqual([
        expect.objectContaining({ type: 'rectangle', autoFit: true, ...NEW_TEXT_BOX_SIZE, html: '' }),
    ]);
    expect(editorOpen()).toBe(true);
});

test('an empty rectangle without fill or border stays when its editor closes', async () => {
    writeElementInDoc(
        doc,
        { type: 'rectangle', x: 0, y: 0, width: 100, height: 100, strokeColor: 'transparent' },
        'a0',
        VECTOR_STYLE_DEFAULTS,
        'box',
    );
    await render('select');
    await doubleClick(50, 50);
    expect(editorOpen()).toBe(true);

    await click(900, 900);
    expect(elements().map((el) => el.id)).toEqual(['box']);
});
