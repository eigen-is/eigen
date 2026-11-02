// An arrow label's width is measured on a canvas and stored, and so is a pasted text box's size. Each face is cut into
// unicode-range slices, and a canvas measures a character whose slice has not loaded in the fallback. So a label is
// measured whenever its text or font changes, once the slices of its text have loaded, and a box pasted before its
// slices arrive is measured again once they have. One file holds both: the measurer keeps the first 2d context it is
// given.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// The font set as a sliced face behaves: a load fetches the slices of its text, and a check without text tests a
// space. Nothing loads until the test releases the network, or fails it, which each test starts cold.
let release = () => {};
let fail = () => {};
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
// At 20 px a character measures `fallbackAdvance` px in the fallback, 10 unless a test says otherwise, and 20 px once its
// slice has loaded. It scales with the font size. `measuredFonts` records the font of each measure, and
// `measuredLines` its text.
let fallbackAdvance = 10;
const measuredFonts: string[] = [];
const measuredLines: string[] = [];
const measureContext = {
    font: '',
    measureText: (line: string) => {
        measuredFonts.push(measureContext.font);
        measuredLines.push(line);
        const scale = Number(/(\d+)px/.exec(measureContext.font)?.[1] ?? 20) / 20;
        return { width: scale * [...line].reduce((w, char) => w + (loaded.has(char) ? 20 : fallbackAdvance), 0) };
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
    network = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = () => reject(new Error('offline'));
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

// Takes edit rights from the rendered canvas, or gives them back, as a permission change does.
let setCanEdit = (_canEdit: boolean) => {};

async function render(canEdit = true): Promise<HTMLElement> {
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        const [selectedIds, setSelectedIds] = useState<string[]>([]);
        const [editable, setEditable] = useState(canEdit);
        setCanEdit = setEditable;
        return createElement(CanvasEditor, {
            doc: canvas,
            viewport: 'infinite',
            styleDefaults: VECTOR_STYLE_DEFAULTS,
            tool: 'select',
            setTool: () => {},
            toolLocked: false,
            setToolLocked: () => {},
            canEdit: editable,
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

async function loadSlices(): Promise<void> {
    await act(async () => {
        release();
        await network;
    });
}

async function failSlices(): Promise<void> {
    await act(async () => {
        fail();
        await network.catch(() => {});
    });
}

const labelText = () => {
    const arrow = readVectorFromDoc(doc).elements.find((el) => el.id === 'arrow');
    return arrow?.type === 'arrow' ? arrow.text : undefined;
};

const labelWidth = () => {
    const arrow = readVectorFromDoc(doc).elements.find((el) => el.id === 'arrow');
    return arrow?.type === 'arrow' ? arrow.labelWidth : undefined;
};

const label = () => ({ text: labelText(), width: labelWidth() });

function storedArrow(on = doc) {
    const stored = on.getMap('elements').get('arrow');
    if (!(stored instanceof Y.Map)) throw new Error('the arrow is not stored');
    return stored;
}

// The arrow starts with the label "go", whose two slices have loaded, at the width they measure. The write is no undo
// step, as if the label came with the file.
function labelGo(labelWidth = 40) {
    for (const char of 'go') loaded.add(char);
    doc.transact(() => {
        storedArrow().set('text', 'go');
        storedArrow().set('labelWidth', labelWidth);
    }, 'file');
}

// Another arrow, labelled `text` and stored at `labelWidth`, as if it came with the file.
function addLabelledArrow(id: string, index: string, text: string, labelWidth: number) {
    writeElementInDoc(
        doc,
        { type: 'arrow', x: 0, y: 100, width: 200, height: 0, points: '[[0,0],[200,0]]', text, labelWidth },
        index,
        VECTOR_STYLE_DEFAULTS,
        id,
    );
}

const widthOf = (id: string) => {
    const arrow = readVectorFromDoc(doc).elements.find((el) => el.id === id);
    return arrow?.type === 'arrow' ? arrow.labelWidth : undefined;
};

// Every write this tab makes from here on, the file's and a peer's left out.
function countWrites(): { count: number } {
    const writes = { count: 0 };
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
        if (origin !== 'file' && origin !== 'peer') writes.count += 1;
    });
    return writes;
}

async function editLabel(container: HTMLElement, text: string): Promise<void> {
    const layer = container.querySelector('[data-element-id="arrow"]');
    if (!layer) throw new Error('no arrow layer');
    await act(async () => {
        layer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 0 }));
    });
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('the label editor did not open');
    await act(async () => {
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
}

test('a label committed before its slices load is measured in the slices of its own text once they load', async () => {
    const container = await render();
    await editLabel(container, '茶 tea');
    expect(labelText()).toBe('茶 tea');
    expect(fontCalls.slice(-2)).toEqual(['check "茶 tea"', 'load "茶 tea"']);

    await loadSlices();
    expect(labelWidth()).toBe(100);
});

// The width follows the text, which is no undo step of its own: ⌘Z takes back the edit, and the old text gets the
// width it measures, never the width the new one healed to.
test('an undone label edit measures the text it brings back, and a redo the text it brings again', async () => {
    labelGo();
    const container = await render();
    await editLabel(container, '茶 tea');
    await loadSlices();
    expect(label()).toEqual({ text: '茶 tea', width: 100 });

    await act(async () => {
        undoManager.undo();
    });
    expect(label()).toEqual({ text: 'go', width: 40 });

    await act(async () => {
        undoManager.redo();
    });
    expect(label()).toEqual({ text: '茶 tea', width: 100 });
});

test("a peer's label edit is measured on this client", async () => {
    labelGo();
    await render();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.on('update', (update: Uint8Array) => Y.applyUpdate(doc, update, 'peer'));
    await act(async () => {
        storedArrow(peer).set('text', 'tea');
    });

    await loadSlices();
    expect(label()).toEqual({ text: 'tea', width: 60 });
});

// The Size row writes the font as the user's own step, and the canvas measures the label in it.
test('a label measures again in a new font size, and an undone size in the old one', async () => {
    labelGo();
    await render();
    await act(async () => {
        undoManager.stopCapturing();
        storedArrow().set('fontSize', 40);
    });
    expect(labelWidth()).toBe(80);

    await act(async () => {
        undoManager.undo();
    });
    expect(labelWidth()).toBe(40);
});

test('a label stored at a width its text does not measure is measured again when the drawing opens', async () => {
    labelGo(7);
    await render();
    expect(labelWidth()).toBe(40);
});

// Every client measures each label, so one whose width is already true writes nothing: not when it opens, not while its
// editor is open, and not on a peer's change that leaves its text and font alone.
test('a label at its measured width is never written', async () => {
    labelGo();
    const writes = countWrites();
    const container = await render();
    const layer = container.querySelector('[data-element-id="arrow"]');
    if (!layer) throw new Error('no arrow layer');
    await act(async () => {
        layer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 0 }));
    });
    expect(container.querySelector('textarea')).not.toBeNull();
    await act(async () => {
        doc.transact(() => storedArrow().set('strokeColor', '#ff0000'), 'peer');
    });
    await loadSlices();
    expect(writes.count).toBe(0);
});

// An editor that is offline, or that blocks the font, would store the fallback's width for everyone, and its peers
// measure nothing on a change to the width alone, so they would never set it right.
test('a label whose slices fail to load keeps the width it has', async () => {
    doc.transact(() => {
        storedArrow().set('text', '茶 tea');
        storedArrow().set('labelWidth', 100);
    }, 'file');
    const writes = countWrites();
    await render();
    await failSlices();
    expect({ width: labelWidth(), writes: writes.count }).toEqual({ width: 100, writes: 0 });
});

test("a new label whose slices fail to load gets the fallback's width, which beats none", async () => {
    doc.transact(() => storedArrow().set('text', '茶 tea'), 'file');
    await render();
    await failSlices();
    expect(labelWidth()).toBe(50);
});

// Each write reads the whole scene again, so a drawing with many labels must not write once per label.
test('labels at the wrong width when the drawing opens are written in one transaction', async () => {
    labelGo(7);
    addLabelledArrow('second', 'a1', 'go', 7);
    addLabelledArrow('third', 'a2', 'go', 7);
    const writes = countWrites();
    await render();
    expect({ widths: ['arrow', 'second', 'third'].map(widthOf), writes: writes.count }).toEqual({
        widths: [40, 40, 40],
        writes: 1,
    });
});

test('labels that wait for their slices are written in one transaction once they load', async () => {
    addLabelledArrow('second', 'a1', 'tea', 7);
    addLabelledArrow('third', 'a2', 'eat', 7);
    const writes = countWrites();
    await render();
    await loadSlices();
    expect({ widths: ['second', 'third'].map(widthOf), writes: writes.count }).toEqual({
        widths: [60, 60],
        writes: 1,
    });
});

test('a change to one label measures that label alone', async () => {
    labelGo();
    addLabelledArrow('second', 'a1', 'go', 40);
    await render();
    measuredLines.length = 0;
    await act(async () => {
        storedArrow().set('text', 'gog');
    });
    expect({ lines: measuredLines, width: labelWidth() }).toEqual({ lines: ['gog'], width: 60 });
});

// The old text's load settles after the edit and before the new text's own load, so it must store nothing: not the
// old text's width, and not the new text measured with one of its characters in the fallback.
test('a label edited while its slices load is stored at the width of its new text alone', async () => {
    doc.transact(() => {
        storedArrow().set('text', 'tea');
        storedArrow().set('labelWidth', 7);
    }, 'file');
    const stored: unknown[] = [];
    storedArrow().observe((event) => {
        if (event.keysChanged.has('labelWidth')) stored.push(storedArrow().get('labelWidth'));
    });
    await render();
    const releaseOld = release;
    const oldNetwork = network;
    network = new Promise<void>((resolve) => {
        release = resolve;
    });
    await act(async () => {
        storedArrow().set('text', 'teas');
    });

    await act(async () => {
        releaseOld();
        await oldNetwork;
    });
    await loadSlices();
    expect(stored).toEqual([80]);
});

// A width alone measures nothing, so only the new handler's fresh start sets right a width that went wrong meanwhile.
test('a canvas that gets its edit rights back measures every label again', async () => {
    labelGo();
    await render();
    await act(async () => setCanEdit(false));
    await act(async () => {
        doc.transact(() => storedArrow().set('labelWidth', 7), 'peer');
    });

    await act(async () => setCanEdit(true));
    expect(labelWidth()).toBe(40);
});

test('a canvas closed before the slices of a label load writes nothing', async () => {
    doc.transact(() => storedArrow().set('text', 'tea'), 'file');
    const writes = countWrites();
    await render();
    await unmount();
    await loadSlices();
    expect(writes.count).toBe(0);
});

test('a canvas that may not edit never writes a label width', async () => {
    labelGo(7);
    const writes = countWrites();
    await render(false);
    await loadSlices();
    expect({ width: labelWidth(), writes: writes.count }).toEqual({ width: 7, writes: 0 });
});

async function paste(fill: (event: ClipboardEvent) => void): Promise<void> {
    const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    fill(event);
    await act(async () => {
        document.dispatchEvent(event);
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

// Each write reads the whole scene again, and a paste can carry hundreds of text items.
test("another app's text items are written in one transaction once their slices load", async () => {
    await render();
    await paste((event) =>
        writeEigenClipboard(event, {
            version: 1,
            items: ['茶 tea', 'tea', 'eat'].map((text) => ({ type: 'text', text, width: 1, height: 1 })),
        }),
    );
    const writes = countWrites();

    await loadSlices();
    const widths = readVectorFromDoc(doc).elements.flatMap((el) => (el.type === 'rectangle' ? [el.width] : []));
    expect({ widths, writes: writes.count }).toEqual({ widths: [100, 60, 60], writes: 1 });
});

// A fallback as wide as the face measures the same size, so the heal has nothing to correct.
test('a pasted box whose late measure matches its size is not written again', async () => {
    fallbackAdvance = 20;
    await render();
    await paste((event) => event.clipboardData?.setData('text/plain', '茶 tea'));
    expect(textBox()).toEqual({ width: 100, height: oneLine });
    const writes = countWrites();

    await loadSlices();
    expect(writes.count).toBe(0);
});
