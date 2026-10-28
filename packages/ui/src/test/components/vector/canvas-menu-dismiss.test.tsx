// A bar menu leaves the page live, so a press outside it reaches what lies under it. On the canvas that press only
// closes the menu: with the eraser it would delete the shape under it, with the text tool place a box.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, Fragment, useEffect, useRef, useState } = await import('react');
const realCollab = await import('@workspace/lib/collab');
const { MediaResolverProvider } = await import('@workspace/lib/drive');
const { generateNKeysBetween, readVectorFromDoc, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import(
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
const { DropdownMenuItem } = await import('../../../components/dropdown-menu');
const { Menubar } = await import('../../../components/menubar');
const { AppBarMenu } = await import('../../../components/layout/toolbar/app-bar-menu');

beforeEach(() => {
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    const [key] = generateNKeysBetween(null, null, 1);
    writeElementInDoc(
        doc,
        { type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
        key,
        VECTOR_STYLE_DEFAULTS,
        'box',
    );
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
        createElement(
            Fragment,
            null,
            createElement(
                Menubar,
                null,
                createElement(AppBarMenu, { label: 'File', children: createElement(DropdownMenuItem, null, 'Print') }),
            ),
            createElement(MediaResolverProvider, {
                ownerId: 'owner',
                mountId: 'mount',
                mediaFolderId: 'media',
                chatFolderId: null,
                children: createElement(Host),
            }),
        ),
    );
    unmount = rendered.unmount;
    container = rendered.container;
    await act(async () => {});
}

function pointer(type: string, clientX: number, clientY: number) {
    return new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX, clientY });
}

async function openFile() {
    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === 'File',
    );
    await act(async () => {
        trigger?.dispatchEvent(pointer('pointerdown', 0, 0));
    });
    // Radix starts listening for a press outside a new menu a tick after it opens.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.querySelectorAll('[role="menu"]').length).toBe(1);
}

// A click on the canvas at 50, 50, inside the box.
async function clickCanvas() {
    const surface = container.querySelector('.origin-top-left')?.parentElement;
    if (!surface) throw new Error('no canvas');
    for (const type of ['pointerdown', 'pointerup']) {
        await act(async () => surface.dispatchEvent(pointer(type, 50, 50)));
    }
}

const elementIds = () => readVectorFromDoc(doc).elements.map((el) => el.id);

test('a press with the eraser that closes File leaves the shape under it', async () => {
    await render('eraser');
    await openFile();
    await clickCanvas();
    expect(document.querySelectorAll('[role="menu"]').length).toBe(0);
    expect(elementIds()).toEqual(['box']);

    // With the menu closed the next press erases.
    await clickCanvas();
    expect(elementIds()).toEqual([]);
});

test('a press with the text tool that closes File places no text box', async () => {
    await render('richtext');
    await openFile();
    await clickCanvas();
    expect(document.querySelectorAll('[role="menu"]').length).toBe(0);
    expect(elementIds()).toEqual(['box']);

    // With the menu closed a click places a text box of the default size.
    await clickCanvas();
    expect(elementIds()).toHaveLength(2);
});
