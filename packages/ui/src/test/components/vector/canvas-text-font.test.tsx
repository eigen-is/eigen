// An arrow label's width is measured on a canvas at commit and stored, and so is a pasted text box's, since ⌘V must take
// or pass on a paste at once. Each face is cut into unicode-range slices, and a canvas measures a character whose slice
// has not loaded in the fallback. So a label committed, or a box pasted, before its slices arrive is measured again once
// the slices of its own text have loaded. One file holds both: the measurer keeps the first 2d context it is given.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// The font set as a sliced face behaves: a load fetches the slices of its text, and a check without text tests a
// space. Nothing loads until the test releases the network, which each test starts cold.
let release = () => {};
let network = Promise.resolve();
const loaded = new Set<string>();
const fontCalls: string[] = [];
const fontFonts: string[] = [];
Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
        ready: Promise.resolve(),
        check: (font: string, text = ' ') => {
            fontCalls.push(`check ${JSON.stringify(text)}`);
            fontFonts.push(font);
            return [...text].every((char) => loaded.has(char));
        },
        load: async (font: string, text = ' ') => {
            fontCalls.push(`load ${JSON.stringify(text)}`);
            fontFonts.push(font);
            await network;
            for (const char of text) loaded.add(char);
            return [];
        },
    },
});
// A character measures `fallbackAdvance` px in the fallback, 10 unless a test says otherwise, and 20 px once its slice
// has loaded. `measuredFonts` records the font of each measure.
let fallbackAdvance = 10;
const measuredFonts: string[] = [];
const measureContext = {
    font: '',
    measureText: (line: string) => {
        measuredFonts.push(measureContext.font);
        return { width: [...line].reduce((w, char) => w + (loaded.has(char) ? 20 : fallbackAdvance), 0) };
    },
};
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => measureContext,
});

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useRef, useState } = await import('react');
const realCollab = await import('@workspace/lib/collab');
const { writeEigenClipboard } = await import('@workspace/lib/clipboard');
const { MediaResolverProvider } = await import('@workspace/lib/drive');
const { getLineHeightPx, readVectorFromDoc, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import(
    '@workspace/lib/vector'
);
type UseCollabDocOptions = Parameters<typeof realCollab.useCollabDoc>[0];

let doc = new Y.Doc();
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
// The scene roots, tracked as useCollabDoc tracks them, so a test can ask what one ⌘Z takes back.
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

beforeEach(() => {
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    undoManager = new Y.UndoManager(doc.getMap('elements'));
    loaded.clear();
    fallbackAdvance = 10;
    network = new Promise<void>((resolve) => {
        release = resolve;
    });
    writeElementInDoc(
        doc,
        { type: 'arrow', x: 0, y: 0, width: 200, height: 0, points: '[[0,0],[200,0]]' },
        'a0',
        VECTOR_STYLE_DEFAULTS,
        'arrow',
    );
});

let unmount = async () => {};
afterEach(() => unmount());

async function render(): Promise<HTMLElement> {
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
    await act(async () => {});
    return rendered.container;
}

const labelText = () => {
    const arrow = readVectorFromDoc(doc).elements.find((el) => el.id === 'arrow');
    return arrow?.type === 'arrow' ? arrow.text : undefined;
};

const labelWidth = () => {
    const arrow = readVectorFromDoc(doc).elements.find((el) => el.id === 'arrow');
    return arrow?.type === 'arrow' ? arrow.labelWidth : undefined;
};

test('a label committed before its slices load is measured again in the slices of its own text', async () => {
    const container = await render();
    const layer = container.querySelector('[data-element-id="arrow"]');
    if (!layer) throw new Error('no arrow layer');
    await act(async () => {
        layer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 0 }));
    });
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('the label editor did not open');
    await act(async () => {
        textarea.value = '茶 tea';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    fontCalls.length = 0;
    await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // Five characters, each in the fallback.
    expect(labelWidth()).toBe(50);
    expect(fontCalls).toEqual(['check "茶 tea"', 'load "茶 tea"']);

    await act(async () => {
        release();
        await network;
    });
    expect(labelWidth()).toBe(100);
});

// The heal corrects a measure the user never made, so ⌘Z takes back the label and not the heal alone, and ⌘⇧Z brings
// the label back at its healed width.
test("a label's heal is not an undo step of its own", async () => {
    const container = await render();
    const layer = container.querySelector('[data-element-id="arrow"]');
    if (!layer) throw new Error('no arrow layer');
    await act(async () => {
        layer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 0 }));
    });
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('the label editor did not open');
    await act(async () => {
        textarea.value = '茶 tea';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {
        release();
        await network;
    });
    expect(labelWidth()).toBe(100);

    await act(async () => {
        undoManager.undo();
    });
    expect(labelText()).toBe('');
    await act(async () => {
        undoManager.redo();
    });
    expect({ text: labelText(), width: labelWidth() }).toEqual({ text: '茶 tea', width: 100 });
});

async function paste(fill: (event: ClipboardEvent) => void): Promise<void> {
    const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    fill(event);
    await act(async () => {
        document.dispatchEvent(event);
    });
}

async function loadSlices(): Promise<void> {
    await act(async () => {
        release();
        await network;
    });
}

const textBox = () => {
    const box = readVectorFromDoc(doc).elements.find((el) => el.type === 'rectangle' && el.autoFit);
    return box && { width: box.width, height: box.height };
};

// One line of the host's font: the height a measure in any face gives.
const oneLine = getLineHeightPx(VECTOR_STYLE_DEFAULTS.fontFamily, VECTOR_STYLE_DEFAULTS.fontSize);

test('pasted plain text sized before its slices load is measured again in the slices of its own text', async () => {
    await render();
    await paste((event) => event.clipboardData?.setData('text/plain', '茶 tea'));
    // Five characters, each in the fallback.
    expect(textBox()).toEqual({ width: 50, height: oneLine });

    await loadSlices();
    expect(textBox()).toEqual({ width: 100, height: oneLine });
});

test("another app's text item sized before its slices load is measured again in the slices of its own text", async () => {
    await render();
    await paste((event) =>
        writeEigenClipboard(event, { version: 1, items: [{ type: 'text', text: '茶 tea', width: 1, height: 1 }] }),
    );
    expect(textBox()).toEqual({ width: 50, height: oneLine });

    await loadSlices();
    expect(textBox()).toEqual({ width: 100, height: oneLine });
});

// Five characters, each followed by its half px of spacing, measured in the bold face and loading its slices.
test("another app's spaced bold text is measured, and measured again, in its own weight and spacing", async () => {
    await render();
    fontFonts.length = 0;
    measuredFonts.length = 0;
    await paste((event) =>
        writeEigenClipboard(event, {
            version: 1,
            items: [
                {
                    type: 'text',
                    text: '茶 tea',
                    width: 1,
                    height: 1,
                    typography: { fontWeight: 'bold', letterSpacing: 0.5 },
                },
            ],
        }),
    );
    expect(textBox()).toEqual({ width: Math.ceil(50 + 2.5), height: oneLine });

    await loadSlices();
    expect(textBox()).toEqual({ width: Math.ceil(100 + 2.5), height: oneLine });
    const fonts = [...fontFonts, ...measuredFonts];
    expect(fonts.length > 0 && fonts.every((font) => font.startsWith('bold '))).toBe(true);
});

// The layer lays its box out at a rounded width, and a box a hair narrower than its text wraps the last word.
test('a pasted box is never narrower than its text', async () => {
    fallbackAdvance = 10.001;
    await render();
    await paste((event) => event.clipboardData?.setData('text/plain', '茶 tea'));
    expect(textBox()).toEqual({ width: 51, height: oneLine });
});

// A box resized while the slices load has a width the user chose, which a late measure must not take back.
test('a pasted box resized before its slices load keeps the width it was given', async () => {
    await render();
    await paste((event) => event.clipboardData?.setData('text/plain', '茶 tea'));
    const box = readVectorFromDoc(doc).elements.find((el) => el.type === 'rectangle');
    if (!box) throw new Error('nothing was pasted');
    const stored = doc.getMap('elements').get(box.id);
    if (!(stored instanceof Y.Map)) throw new Error('the box is not stored');
    await act(async () => {
        stored.set('width', 300);
    });

    await loadSlices();
    expect(textBox()).toEqual({ width: 300, height: oneLine });
});

test("a pasted box's heal is not an undo step of its own", async () => {
    await render();
    await paste((event) => event.clipboardData?.setData('text/plain', '茶 tea'));
    await loadSlices();
    expect(textBox()).toEqual({ width: 100, height: oneLine });

    await act(async () => {
        undoManager.undo();
    });
    expect(textBox()).toBeUndefined();
});

// The fallback is narrower here, but a wider one wraps the text, and the fit grows the box to the lines it wrapped
// into. The fit only grows, so the heal sets the height its one line needs as well as the width.
test("a pasted box's heal takes back the height a fallback's wrap grew it to", async () => {
    await render();
    await paste((event) => event.clipboardData?.setData('text/plain', '茶 tea'));
    const box = readVectorFromDoc(doc).elements.find((el) => el.type === 'rectangle');
    if (!box) throw new Error('nothing was pasted');
    const stored = doc.getMap('elements').get(box.id);
    if (!(stored instanceof Y.Map)) throw new Error('the box is not stored');
    await act(async () => {
        doc.transact(() => stored.set('height', 3 * oneLine), 'fit');
    });

    await loadSlices();
    expect(textBox()).toEqual({ width: 100, height: oneLine });
});

// A box made bold while the slices load is measured in another face, so a late measure in the old one is stale.
test('a pasted box restyled before its slices load keeps the size it has', async () => {
    await render();
    await paste((event) => event.clipboardData?.setData('text/plain', '茶 tea'));
    const box = readVectorFromDoc(doc).elements.find((el) => el.type === 'rectangle');
    if (!box) throw new Error('nothing was pasted');
    const stored = doc.getMap('elements').get(box.id);
    if (!(stored instanceof Y.Map)) throw new Error('the box is not stored');
    await act(async () => {
        stored.set('fontWeight', 'bold');
    });

    await loadSlices();
    expect(textBox()).toEqual({ width: 50, height: oneLine });
});
