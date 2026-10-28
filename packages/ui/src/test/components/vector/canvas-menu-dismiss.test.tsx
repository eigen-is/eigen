// A bar menu leaves the page live, so a press outside it and a key pressed in it reach what lies under it. On the
// canvas that press only closes the menu: with the eraser it would delete the shape under it, with the text tool
// place a box. The keys belong to the menu.
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

let toolPicks: VectorTool[] = [];
let selection: string[] = [];

async function render(tool: VectorTool, selected: string[] = []) {
    toolPicks = [];
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        const [selectedIds, setSelectedIds] = useState(selected);
        selection = selectedIds;
        return createElement(CanvasEditor, {
            doc: canvas,
            viewport: 'infinite',
            styleDefaults: VECTOR_STYLE_DEFAULTS,
            tool,
            setTool: (picked: VectorTool) => toolPicks.push(picked),
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

// The press that closes the menu is still the first finger of a pinch: the touch handler sees it, so the second
// finger, which lands with the menu gone, makes two and the lift of both places nothing, as a single tap would.
test('a finger that closes File still counts toward a pinch', async () => {
    await render('richtext');
    await openFile();
    const surface = container.querySelector('.origin-top-left')?.parentElement;
    if (!surface) throw new Error('no canvas');
    surface.setPointerCapture = () => {};
    surface.releasePointerCapture = () => {};
    const touch = (type: string, pointerId: number) =>
        act(async () => {
            surface.dispatchEvent(
                new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    button: 0,
                    pointerId,
                    pointerType: 'touch',
                    clientX: 40 + pointerId * 10,
                    clientY: 50,
                }),
            );
        });
    await touch('pointerdown', 1);
    await touch('pointerdown', 2);
    await touch('pointerup', 2);
    await touch('pointerup', 1);
    expect(document.querySelectorAll('[role="menu"]').length).toBe(0);
    expect(elementIds()).toEqual(['box']);
});

// Keys pressed in an open menu belong to the menu. They must not nudge, delete or deselect the shape behind it,
// or switch the tool.
test('keys pressed in an open File menu leave the selected shape and the tool alone', async () => {
    await render('select', ['box']);
    await openFile();
    const focused = document.activeElement ?? document.body;
    for (const key of ['ArrowRight', 'ArrowDown', 'Delete', 'Backspace', 'r', 'Escape']) {
        await act(async () => {
            focused.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
    }
    expect(readVectorFromDoc(doc).elements.map(({ id, x, y }) => ({ id, x, y }))).toEqual([{ id: 'box', x: 0, y: 0 }]);
    expect(toolPicks).toEqual([]);
    expect(selection).toEqual(['box']);
});
