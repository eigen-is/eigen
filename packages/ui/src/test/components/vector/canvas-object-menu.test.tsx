// A canvas object's menu downloads what it is about: a selection, or a chart alone, as Download image, the SVG the
// browser draws, and a single image only as its original file. A viewer, who selects nothing, gets the same rows for
// the element right-clicked. The selection's file draws its text as SVG text and embeds the faces it uses.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { stubCanvasImageFonts } from '../../canvas-image';
import { installHappyDom } from '../../happy-dom';
import { menuRows } from '../../menu-rows';
import { renderInDocument } from '../../render-in-document';

const window = installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useRef, useState } = await import('react');
const realCollab = await import('@workspace/lib/collab');
const download = await import('@workspace/lib/download');
const { sampleChartSpec } = await import('@workspace/lib/charts');
const { MediaResolverProvider } = await import('@workspace/lib/drive');
const { generateNKeysBetween, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import('@workspace/lib/vector');
const { drivePath } = await import('../../drive-path');
type NewVectorElement = import('@workspace/lib/vector').NewVectorElement;
type UseCollabDocOptions = Parameters<typeof realCollab.useCollabDoc>[0];

let doc = new Y.Doc();
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
// The canvas reads the test's doc, with no server behind it.
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: (options: UseCollabDocOptions) => {
        const docRef = useRef(doc);
        // Once per doc, as the real hook runs it: the host's onInit is a fresh closure every render.
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

const CAT = drivePath({ id: 'cat', name: 'cat.png', mimeType: 'image/png', parentId: 'media' });
const FONT_BYTES = new Uint8Array([119, 79, 70, 50]);
const fonts = stubCanvasImageFonts();
spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
        async (input: RequestInfo | URL) =>
            String(input).startsWith('/fonts/') ? new Response(FONT_BYTES) : Response.json([CAT]),
        { preconnect: fetch.preconnect },
    ),
);
// happy-dom lays nothing out: every character of a measured text box sits 8 px after the one before it.
const { getClientRects } = window.Range.prototype;
Object.defineProperty(window.Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) {
        return [{ left: this.startOffset * 8, top: 0, width: 8, height: 20 }];
    },
});
afterAll(() => {
    Object.defineProperty(window.Range.prototype, 'getClientRects', { configurable: true, value: getClientRects });
});

const chartSpec = JSON.stringify({ ...sampleChartSpec('column'), title: { text: 'Light' } });
const ELEMENTS: (NewVectorElement & { id: string })[] = [
    { id: 'r', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
    {
        id: 't',
        type: 'richtext',
        x: 200,
        y: 0,
        width: 200,
        height: 50,
        html: '<p>Hi there</p>',
        fontFamily: 'Inter',
    },
    { id: 'c', type: 'chart', x: 0, y: 200, width: 300, height: 200, chart: chartSpec },
    { id: 'i', type: 'image', x: 400, y: 200, width: 100, height: 100, mediaName: 'cat.png' },
];
const POINT = { r: [50, 50], t: [250, 20], c: [150, 300], i: [450, 250] } as const;

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

let surface: Element | null = null;

const canvasRef: { current: import('../../../components/vector').CanvasHandle | null } = { current: null };

async function render(canEdit: boolean, selected: string[] = []) {
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        const [selectedIds, setSelectedIds] = useState(selected);
        return createElement(CanvasEditor, {
            doc: canvas,
            viewport: 'infinite',
            styleDefaults: VECTOR_STYLE_DEFAULTS,
            tool: 'select',
            setTool: () => {},
            toolLocked: false,
            setToolLocked: () => {},
            canEdit,
            ownerId: 'owner',
            mountId: 'mount',
            fileName: 'Plan',
            selectedIds,
            setSelectedIds,
            toggle: () => {},
            aspectLocked: false,
            publishCursor: () => {},
            canvasRef,
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
    // The scene layer, inside the container whose handler hit-tests the point.
    surface = rendered.container.querySelector('.origin-top-left');
    await act(async () => {});
}

async function rightClick(at: keyof typeof POINT) {
    const target = surface;
    if (!target) throw new Error('no canvas');
    const [clientX, clientY] = POINT[at];
    await act(async () => {
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
    });
}

async function pick(label: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) => entry.textContent?.trim() === label,
    );
    if (!item) throw new Error(`no ${label} item`);
    await act(async () => item.click());
}

const EDIT_ROWS = ['Cut', 'Copy', 'Paste', '—', 'Duplicate', '—', 'Order', '—'];

test("a writer's menu on a shape downloads it as an image", async () => {
    await render(true);
    await rightClick('r');
    expect(menuRows()).toEqual([...EDIT_ROWS, 'Download image', '—', 'Delete']);
});

test('a single image downloads only its original file', async () => {
    await render(true);
    await rightClick('i');
    expect(menuRows()).toEqual([...EDIT_ROWS, 'Download original image', '—', 'Delete']);
});

test('a selection with an image in it offers both, the image right-clicked by its original file', async () => {
    await render(true, ['r', 'i']);
    await rightClick('i');
    expect(menuRows()).toEqual([...EDIT_ROWS, 'Download original image', 'Download image', '—', 'Delete']);
});

test("a viewer's menu has the download row for the element right-clicked, and none over empty canvas", async () => {
    await render(false);
    await rightClick('r');
    expect(menuRows()).toEqual(['Download image']);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await rightClick('i');
    expect(menuRows()).toEqual(['Download original image']);
});

test('a chart alone downloads on white, named for its title', async () => {
    const saved = spyOn(download, 'downloadBlob').mockImplementation(() => {});
    try {
        await render(false);
        await rightClick('c');
        await pick('Download image');
        await act(async () => {});
        const [blob, name] = saved.mock.calls[0];
        expect(name).toBe('Light.svg');
        expect(await blob.text()).toContain('fill="#ffffff"');
    } finally {
        saved.mockRestore();
    }
});

test('a selection downloads on nothing, its text as SVG text in the faces it uses, embedded', async () => {
    const saved = spyOn(download, 'downloadBlob').mockImplementation(() => {});
    try {
        await render(true, ['r', 't']);
        fonts.takeFetched();
        await rightClick('t');
        await pick('Download image');
        await act(async () => {});
        expect(saved).toHaveBeenCalledTimes(1);
        const [blob, name] = saved.mock.calls[0];
        expect(name).toBe('Plan – selection.svg');
        const svg = await blob.text();
        expect(svg).not.toContain('fill="#ffffff"');
        expect(svg).toContain('<tspan');
        expect(svg).toContain('>Hi there</tspan>');
        expect(svg).not.toContain('<foreignObject');
        expect(fonts.takeFetched()).toEqual(['inter/Inter-Variable.woff2']);
        expect(svg).toContain('font-family: "Inter"');
        expect(svg).toContain(`data:font/woff2;base64,${btoa(String.fromCharCode(...FONT_BYTES))}`);
    } finally {
        saved.mockRestore();
    }
});

// The paste reader stops at 10,000 records; the editor's own drawing is no clipboard input, so it is read as it is.
test("File › Download › SVG draws every element on the drawing's background, named for the file", async () => {
    const saved = spyOn(download, 'downloadBlob').mockImplementation(() => {});
    try {
        await render(true);
        await act(async () => canvasRef.current?.downloadDrawing());
        const [blob, name] = saved.mock.calls[0];
        expect(name).toBe('Plan.svg');
        const svg = await blob.text();
        // The four elements' bounds, 500 × 400 from the origin, plus the 10 px margin.
        expect(svg).toContain('viewBox="-10 -10 520 420"');
        expect(svg).toContain('>Light<');
        expect(svg).toContain('<image');
    } finally {
        saved.mockRestore();
    }
});
