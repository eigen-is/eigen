// A figure in front of or behind the text takes no room on its line, so the keyboard never lands on it: it always
// leads its paragraph, the caret rests after it, and ArrowLeft, Backspace, Delete and Enter there act as at a plain
// paragraph's start, a join keeping the image where it is drawn. It is selected with the pointer only, a behind one by
// where the pointer is. A drop re-anchors it on the paragraph under its top and clamps it on the page map's paper, a
// switch to front or behind keeps it in place, and outside the body it draws in line.
import { afterEach, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { act, createElement } = await import('react');
const { default: Collaboration } = await import('@tiptap/extension-collaboration');
const { Editor, EditorContent } = await import('@tiptap/react');
const { DEFAULT_PAGE_SETUP, getDocExtensions, pagePx } = await import('@workspace/lib/docs/eigendoc');
const { Figure } = await import('../../../../components/docs/extensions/figure');
const { PositionedFigures } = await import('../../../../components/docs/extensions/positioned-figure');
const { createDocUndoManager } = await import('../../../../components/docs/page-setup');

type TestEditor = InstanceType<typeof Editor>;

let unmount = async () => {};
afterEach(() => unmount());

// An 800 px paper with 100 px margins: a 600 px text column from x 100.
const PAGE: PageSetup = {
    ...DEFAULT_PAGE_SETUP,
    width: 800,
    height: 1000,
    margin: { top: 100, right: 100, bottom: 100, left: 100 },
};

const image = (attrs: object = {}) => ({
    type: 'figure',
    attrs: { src: 'data:image/png;base64,', width: 200, ...attrs },
});
const front = (attrs: object = {}) => image({ layout: 'front', offsetX: 10, offsetY: 20, ...attrs });
const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });

// `undoManager` binds the editor to a Yjs doc, whose undo steps the test counts.
async function mount(
    content: object[],
    options: {
        band?: boolean;
        note?: boolean;
        editable?: boolean;
        page?: PageSetup;
        undoManager?: InstanceType<typeof Y.UndoManager>;
    } = {},
) {
    const { undoManager } = options;
    const editor = new Editor({
        editable: options.editable ?? true,
        extensions: [
            ...getDocExtensions({ exclude: ['figure', 'comment'] }),
            Figure,
            PositionedFigures.configure({
                page: () => options.page ?? PAGE,
                band: options.band ?? false,
                note: options.note ?? false,
            }),
            ...(undoManager
                ? [Collaboration.configure({ document: undoManager.doc, yUndoOptions: { undoManager } })]
                : []),
        ],
        content: undoManager ? undefined : { type: 'doc', content },
    });
    if (undoManager) {
        editor.commands.setContent({ type: 'doc', content });
        undoManager.clear();
    }
    const rendered = await renderInDocument(
        createElement('div', { 'data-document': '' }, createElement(EditorContent, { editor })),
    );
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    await act(async () => {});
    return editor;
}

// The doc as each block's children: text, or the node's type with its layout when it has one.
const blocks = (editor: TestEditor) =>
    editor.state.doc
        .toJSON()
        .content.map((block: JSONContent) =>
            (block.content ?? []).map((node) =>
                node.type === 'text'
                    ? node.text
                    : node.attrs?.['layout']
                      ? `${node.type}:${node.attrs['layout']}`
                      : node.type,
            ),
        );

const press = (editor: TestEditor, key: string, init: KeyboardEventInit = {}) =>
    act(async () => {
        editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    });

const place = (element: Element | null | undefined, x: number, y: number, width = 200, height = 100) => {
    if (!element) throw new Error('nothing to place');
    element.getBoundingClientRect = () => DOMRect.fromRect({ x, y, width, height });
};

// The drawn box of the figure at `pos`: the frame's content, inside the node view's wrapper.
const figureBox = (editor: TestEditor, pos: number) => {
    const dom = editor.view.nodeDOM(pos);
    return dom instanceof Element ? dom.firstElementChild?.firstElementChild : null;
};
const blockDom = (editor: TestEditor, pos: number) => {
    const dom = editor.view.nodeDOM(pos);
    return dom instanceof Element ? dom : null;
};

// "xy" in the first paragraph (1 to 3), the second at 4 leading with the figure at 5, "abc" from 6.
const twoParagraphs = () => [paragraph(text('xy')), paragraph(front(), text('abc'))];

test('a caret placed before the leading run rests after it', async () => {
    const editor = await mount(twoParagraphs());
    await act(async () => {
        editor.commands.setTextSelection(5);
    });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 6, head: 6 });
});

test('ArrowLeft at the visual start goes to the end of the paragraph above and never selects the image', async () => {
    const editor = await mount(twoParagraphs());
    await act(async () => {
        editor.commands.setTextSelection(6);
    });
    await press(editor, 'ArrowLeft');
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 3, head: 3 });
});

const selectBetween = (editor: TestEditor, anchor: number, head: number) =>
    act(async () => {
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)));
    });

// The paragraph above is drawn 40 px higher than the image's own, so the kept place is 40 px further down from it.
test('Shift+ArrowLeft at the visual start selects back to the paragraph above without the image, whose place Backspace keeps', async () => {
    const editor = await mount(twoParagraphs());
    place(blockDom(editor, 0), 100, 60, 600, 20);
    place(blockDom(editor, 4), 100, 100, 600, 20);
    place(figureBox(editor, 5), 110, 120);
    await act(async () => {
        editor.commands.setTextSelection(6);
    });
    await press(editor, 'ArrowLeft', { shiftKey: true });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 5, head: 3 });
    await press(editor, 'Backspace');
    expect(blocks(editor)).toEqual([['figure:front', 'xyabc']]);
    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ offsetX: 10, offsetY: 60 });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 4, head: 4 });
});

// As Shift+Home and Shift+Up can land, before the image or between two.
test('a selection extended back into the leading run stops after it', async () => {
    const editor = await mount(twoParagraphs());
    await selectBetween(editor, 8, 5);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 8, head: 6 });
});

// Two images lead each paragraph: the first's run at 1 and 2 before "ab" at 3, the second's at 7 and 8 before "cd" at 9.
// As Shift+Up from the second's visual start, a drag from line start to line start, or a pointer between two images.
test.each([
    [9, 1, 7, 3],
    [1, 9, 3, 7],
    [8, 2, 7, 3],
    [2, 8, 3, 7],
])(
    'a selection from %d to %d with both ends in a leading run ends outside both runs',
    async (anchor, head, from, to) => {
        const editor = await mount([paragraph(front(), front(), text('ab')), paragraph(front(), front(), text('cd'))]);
        await selectBetween(editor, anchor, head);
        expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: from, head: to });
        await press(editor, 'Backspace');
        expect(blocks(editor)).toEqual([['figure:front', 'figure:front', 'figure:front', 'figure:front', 'cd']]);
    },
);

test('a selection from above that ends at the visual start stops before the run, and Shift+ArrowRight steps past it', async () => {
    const editor = await mount(twoParagraphs());
    await selectBetween(editor, 2, 6);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 2, head: 5 });
    await press(editor, 'ArrowRight', { shiftKey: true });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 2, head: 7 });
});

test.each(['Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])(
    '%s on a selected positioned image puts the caret at the visual start of its paragraph',
    async (key) => {
        const editor = await mount(twoParagraphs());
        await act(async () => {
            editor.commands.setNodeSelection(5);
        });
        await press(editor, key);
        expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 6, head: 6 });
    },
);

test.each(['Backspace', 'Delete'])('%s on a selected positioned image deletes it', async (key) => {
    const editor = await mount(twoParagraphs());
    await act(async () => {
        editor.commands.setNodeSelection(5);
    });
    await press(editor, key);
    expect(blocks(editor)).toEqual([['xy'], ['abc']]);
});

// The paragraph above is drawn 40 px higher than the image's own, so the kept place is 40 px further down from it.
test.each([
    ['Backspace at the visual start', 6, 'Backspace'],
    ['Delete at the end of the paragraph above', 3, 'Delete'],
])('%s joins the paragraphs and keeps the image where it is drawn', async (_name, caret, key) => {
    const editor = await mount(twoParagraphs());
    place(blockDom(editor, 0), 100, 60, 600, 20);
    place(blockDom(editor, 4), 100, 100, 600, 20);
    place(figureBox(editor, 5), 110, 120);
    await act(async () => {
        editor.commands.setTextSelection(caret);
    });
    await press(editor, key);
    expect(blocks(editor)).toEqual([['figure:front', 'xyabc']]);
    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ offsetX: 10, offsetY: 60 });
    // The caret stays at the join, between "xy" and "abc".
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 4, head: 4 });
});

test('Backspace at the visual start of the first paragraph keeps the image', async () => {
    const editor = await mount([paragraph(front(), text('abc'))]);
    await act(async () => {
        editor.commands.setTextSelection(2);
    });
    await press(editor, 'Backspace');
    expect(blocks(editor)).toEqual([['figure:front', 'abc']]);
});

test('Enter at the visual start opens an empty paragraph above, and the image goes down with its text', async () => {
    const editor = await mount(twoParagraphs());
    await act(async () => {
        editor.commands.setTextSelection(6);
    });
    await press(editor, 'Enter');
    expect(blocks(editor)).toEqual([['xy'], [], ['figure:front', 'abc']]);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 8, head: 8 });
});

test('Enter in the middle of an anchor paragraph leaves the image in the upper part', async () => {
    const editor = await mount(twoParagraphs());
    await act(async () => {
        editor.commands.setTextSelection(7);
    });
    await press(editor, 'Enter');
    expect(blocks(editor)).toEqual([['xy'], ['figure:front', 'a'], ['bc']]);
});

test('a positioned image inserted mid-paragraph moves to the start, after the leading run', async () => {
    const editor = await mount(twoParagraphs());
    await act(async () => {
        editor.commands.insertContentAt(8, front({ layout: 'behind' }));
    });
    expect(blocks(editor)).toEqual([['xy'], ['figure:front', 'figure:behind', 'abc']]);
});

test("a peer's positioned image mid-paragraph is left to the peer, and so is a viewer's", async () => {
    const editor = await mount(twoParagraphs());
    await act(async () => {
        const { state, schema } = editor;
        const node = schema.nodeFromJSON(front());
        editor.view.dispatch(state.tr.insert(8, node).setMeta(ySyncPluginKey, { isChangeOrigin: true }));
    });
    expect(blocks(editor)).toEqual([['xy'], ['figure:front', 'ab', 'figure:front', 'c']]);

    const viewer = await mount(twoParagraphs(), { editable: false });
    await act(async () => {
        viewer.view.dispatch(viewer.state.tr.insert(8, viewer.schema.nodeFromJSON(front())));
    });
    expect(blocks(viewer)).toEqual([['xy'], ['figure:front', 'ab', 'figure:front', 'c']]);
});

const cellTable = (...content: object[]) => ({
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph(...content)] }] }],
});

test('a positioned image that lands in a table cell, or is switched to in a note, draws in line', async () => {
    const editor = await mount([
        cellTable(text('cell')),
        paragraph(text('a'), { type: 'footnote', content: [paragraph(image(), text('n'))] }),
    ]);
    // The cell's paragraph starts at 3, and once the cell holds the figure the note's figure is at 17.
    await act(async () => {
        editor.commands.insertContentAt(4, front());
    });
    expect(editor.state.doc.nodeAt(17)?.type.name).toBe('figure');
    await act(async () => {
        editor.view.dispatch(editor.state.tr.setNodeAttribute(17, 'layout', 'behind'));
    });
    const layouts: unknown[] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'figure') layouts.push(node.attrs['layout']);
    });
    expect(layouts).toEqual(['block', 'block']);
});

test.each([
    ['band', { band: true }],
    ['note', { note: true }],
])("in a %s's editor every positioned image draws in line", async (_root, root) => {
    const editor = await mount([paragraph(text('a'))], root);
    await act(async () => {
        editor.commands.insertContentAt(2, front());
    });
    expect(blocks(editor)).toEqual([['a', 'figure:block']]);
});

test('a switch to in front of the text keeps the image where it is drawn, leads it and keeps it selected', async () => {
    // "ab" at 1 to 3, the block figure at 3.
    const editor = await mount([paragraph(text('ab'), image())]);
    place(blockDom(editor, 0), 100, 100, 600, 120);
    place(figureBox(editor, 3), 300, 130);
    await act(async () => {
        editor.commands.setNodeSelection(3);
    });
    await act(async () => {
        editor.commands.positionFigure('front');
    });
    expect(blocks(editor)).toEqual([['figure:front', 'ab']]);
    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ offsetX: 200, offsetY: 30 });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 1 });
});

test('a switch between front and behind moves nothing', async () => {
    const editor = await mount(twoParagraphs());
    await act(async () => {
        editor.commands.setNodeSelection(5);
    });
    await act(async () => {
        editor.commands.positionFigure('behind');
    });
    expect(blocks(editor)).toEqual([['xy'], ['figure:behind', 'abc']]);
    expect(editor.state.doc.nodeAt(5)?.attrs).toMatchObject({ offsetX: 10, offsetY: 20 });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 5 });
});

// The text column at x 100 holds the first paragraph from y 100 to 120 and the second from y 120 to 140, whose image
// draws at its offsets, 10 and 20.
async function twoLaidOut(page = PAGE, column = { x: 100, width: 600 }) {
    const editor = await mount(
        [paragraph(text('xy')), paragraph(front({ commentCardId: 'card' }), text('abc')), paragraph(text('z'))],
        { page },
    );
    place(editor.view.dom, column.x, 100, column.width, 300);
    place(blockDom(editor, 0), column.x, 100, column.width, 20);
    place(blockDom(editor, 4), column.x, 120, column.width, 20);
    place(blockDom(editor, 10), column.x, 140, column.width, 20);
    await act(async () => {
        editor.commands.setNodeSelection(5);
    });
    return editor;
}

test('a drop under another paragraph anchors the image there, kept selected with its comment', async () => {
    const editor = await twoLaidOut();
    await act(async () => {
        editor.commands.moveFigure(5, { dx: 40, dy: 10 });
    });
    expect(blocks(editor)).toEqual([['xy'], ['abc'], ['figure:front', 'z']]);
    expect(editor.state.doc.nodeAt(10)?.attrs).toMatchObject({ offsetX: 50, offsetY: 10, commentCardId: 'card' });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 10 });
});

test('a drop within its own paragraph writes the offsets alone', async () => {
    const editor = await twoLaidOut();
    const before = editor.state.doc.nodeAt(5);
    await act(async () => {
        editor.commands.moveFigure(5, { dx: 20, dy: -15 });
    });
    expect(blocks(editor)).toEqual([['xy'], ['figure:front', 'abc'], ['z']]);
    expect(editor.state.doc.nodeAt(5)?.attrs).toMatchObject({ offsetX: 30, offsetY: 5 });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 5 });
    expect(before).not.toBe(editor.state.doc.nodeAt(5));
});

test("a drop keeps the image on the paper: within its edges, and below the page's top", async () => {
    const editor = await twoLaidOut();
    // The paragraph's left edge is the paper's x 100; a 200 px image fits up to the paper's x 600.
    await act(async () => {
        editor.commands.moveFigure(5, { dx: 1890, dy: -15 });
    });
    expect(editor.state.doc.nodeAt(5)?.attrs).toMatchObject({ offsetX: 500 });
    await act(async () => {
        editor.commands.moveFigure(5, { dx: -1100, dy: -625 });
    });
    // Above the first paragraph it anchors there, on the page's top.
    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ offsetX: -100, offsetY: -100 });
});

// The page-less contract with J3: the stored place never depends on the column a screen lays out.
test("on an A4 page map with the column laid out 360 px wide, a drop clamps at the paper's edge, not the column's", async () => {
    const a4 = pagePx(DEFAULT_PAGE_SETUP);
    const editor = await twoLaidOut(a4, { x: 0, width: 360 });
    await act(async () => {
        editor.commands.moveFigure(5, { dx: 4990, dy: -15 });
    });
    expect(editor.state.doc.nodeAt(5)?.attrs['offsetX']).toBe(Math.round(a4.width - 200 - a4.margin.left));
});

// The page-less side of the J1 contract: a page-less doc lays its column out at the reader's width, a phone's 360 px or
// a desktop's Narrow 696 px, and the same drag stores the same offsets on both, clamped only at the page map's paper.
// The box draws clamped into the column and the strip beside it by CSS, from the place its node view writes as custom
// properties, so drawing it there writes nothing.
test('on a page-less doc, a drag stores the same offsets in a 360 px column and a 696 px one', async () => {
    const a4 = { ...pagePx(DEFAULT_PAGE_SETUP), pageless: true };
    const stored: unknown[] = [];
    for (const width of [360, 696]) {
        const editor = await twoLaidOut(a4, { x: 0, width });
        await act(async () => {
            editor.commands.moveFigure(5, { dx: 300, dy: -15 });
        });
        const box = blockDom(editor, 5)?.querySelector<HTMLElement>('.figure');
        stored.push({
            offsets: editor.state.doc.nodeAt(5)?.attrs['offsetX'],
            left: box?.style.getPropertyValue('--figure-left'),
            width: box?.style.getPropertyValue('--figure-width'),
        });
        await unmount();
    }
    expect(stored).toEqual([
        { offsets: 310, left: '310px', width: '200px' },
        { offsets: 310, left: '310px', width: '200px' },
    ]);
});

// Behind-image selection by geometry: the paragraph's box lies over the image, its text only where its lines are.
async function behindUnderText() {
    const editor = await mount([paragraph(front({ layout: 'behind' }), text('abc'))]);
    const paragraphDom = blockDom(editor, 0);
    const box = editor.view.dom.querySelector('.figure[data-layout="behind"]');
    if (!paragraphDom || !box) throw new Error('not drawn');
    const hits = [paragraphDom, editor.view.dom, box.querySelector('img') ?? box, box];
    const restore = { points: document.elementsFromPoint, rects: Range.prototype.getClientRects };
    document.elementsFromPoint = () => hits;
    // One line of text, 50 px wide at the paragraph's left.
    const line = DOMRect.fromRect({ x: 0, y: 0, width: 50, height: 20 });
    Range.prototype.getClientRects = () => ({
        0: line,
        length: 1,
        item: (index: number) => (index === 0 ? line : null),
        [Symbol.iterator]: () => [line][Symbol.iterator](),
    });
    const unmountEditor = unmount;
    unmount = async () => {
        document.elementsFromPoint = restore.points;
        Range.prototype.getClientRects = restore.rects;
        await unmountEditor();
    };
    const mousedown = (clientX: number, altKey = false) =>
        act(async () => {
            paragraphDom.dispatchEvent(
                new MouseEvent('mousedown', {
                    bubbles: true,
                    cancelable: true,
                    button: 0,
                    clientX,
                    clientY: 10,
                    altKey,
                }),
            );
        });
    return { editor, mousedown };
}

test('a press on a bare part of a paragraph over a behind image selects the image', async () => {
    const { editor, mousedown } = await behindUnderText();
    await mousedown(300);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 1 });
});

test('a press on the text over a behind image is the text’s, and Alt takes the image', async () => {
    const { editor, mousedown } = await behindUnderText();
    const before = editor.state.selection.toJSON();
    await mousedown(20);
    expect(editor.state.selection.toJSON()).toEqual(before);
    await mousedown(20, true);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 1 });
});

// The test harness runs a frame at once. These frames wait until the test runs them, as a browser runs them after a
// task's changes.
function holdFrames() {
    const frames: FrameRequestCallback[] = [];
    const inline = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => frames.push(callback);
    const unmountEditor = unmount;
    unmount = async () => {
        globalThis.requestAnimationFrame = inline;
        await unmountEditor();
    };
    return () =>
        act(async () => {
            for (const frame of frames.splice(0)) frame(0);
        });
}

test('the body grows under the lowest positioned image once a frame, and only while one is there', async () => {
    const editor = await mount([paragraph(front(), text('abc'))]);
    const nextFrame = holdFrames();
    place(editor.view.dom, 100, 100, 600, 50);
    const box = editor.view.dom.querySelector('.figure');
    place(box, 110, 120, 200, 400);
    let reads = 0;
    const measure = box?.getBoundingClientRect;
    if (box && measure)
        box.getBoundingClientRect = () => {
            reads++;
            return measure();
        };
    await act(async () => {
        editor.commands.insertContentAt(3, 'd');
        editor.commands.insertContentAt(3, 'e');
    });
    expect(reads).toBe(0);
    await nextFrame();
    expect(reads).toBe(1);
    expect(editor.view.dom.style.minHeight).toBe('420px');
    await act(async () => {
        editor.commands.setNodeSelection(1);
        editor.commands.deleteSelection();
    });
    await nextFrame();
    expect(editor.view.dom.style.minHeight).toBe('');
});

test('a width a collaborator stored as no number is read as unset, so a switch to in front takes the drawn width', async () => {
    const editor = await mount([paragraph(text('ab'), image({ width: 'wide' }))]);
    place(editor.view.dom, 100, 100, 600, 300);
    place(blockDom(editor, 0), 100, 100, 600, 120);
    place(figureBox(editor, 3), 650, 130);
    await act(async () => {
        editor.commands.setNodeSelection(3);
    });
    await act(async () => {
        editor.commands.positionFigure('front');
    });
    // The 200 px drawn box stops at the 800 px paper's right edge: x 600, 500 from the paragraph's left.
    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ offsetX: 500, offsetY: 30 });
});

test('one transaction that inserts positioned images in paragraphs far apart leads each in its paragraph', async () => {
    const editor = await mount([paragraph(text('abc')), paragraph(text('mid')), paragraph(text('xyz'))]);
    await act(async () => {
        const { state, schema } = editor;
        const tr = state.tr.insert(13, schema.nodeFromJSON(front())).insert(2, schema.nodeFromJSON(front()));
        editor.view.dispatch(tr);
    });
    expect(blocks(editor)).toEqual([['figure:front', 'abc'], ['mid'], ['figure:front', 'xyz']]);
});

test('a re-anchor and a Backspace join are one undo step each', async () => {
    const undoManager = createDocUndoManager(new Y.Doc());
    const editor = await mount(twoParagraphs(), { undoManager });
    const original = blocks(editor);
    place(editor.view.dom, 100, 100, 600, 300);
    place(blockDom(editor, 0), 100, 100, 600, 20);
    place(blockDom(editor, 4), 100, 120, 600, 20);
    place(figureBox(editor, 5), 110, 140);

    await act(async () => {
        editor.commands.moveFigure(5, { dx: 0, dy: -35 });
    });
    expect(blocks(editor)).toEqual([['figure:front', 'xy'], ['abc']]);
    expect(undoManager.undoStack.length).toBe(1);
    await act(async () => {
        undoManager.undo();
    });
    expect(blocks(editor)).toEqual(original);

    undoManager.clear();
    await act(async () => {
        editor.commands.setTextSelection(6);
    });
    await press(editor, 'Backspace');
    expect(blocks(editor)).toEqual([['figure:front', 'xyabc']]);
    expect(undoManager.undoStack.length).toBe(1);
    await act(async () => {
        undoManager.undo();
    });
    expect(blocks(editor)).toEqual(original);
});

// As at a plain item's start, the item lifts out of the list, its image with it.
test('Backspace at the visual start of a list item lifts it out of the list, as without the image', async () => {
    const item = (...content: object[]) => ({ type: 'listItem', content: [paragraph(...content)] });
    // "a" in the first item at 3; the second item's paragraph at 6 leads with the image at 7, "b" from 8.
    const editor = await mount([{ type: 'bulletList', content: [item(text('a')), item(front(), text('b'))] }]);
    await act(async () => {
        editor.commands.setTextSelection(8);
    });
    await press(editor, 'Backspace');
    const [list, lifted] = editor.state.doc.toJSON().content;
    expect(list.content).toHaveLength(1);
    expect(blocks(editor)[1]).toEqual(['figure:front', 'b']);
    expect(lifted.content[0].attrs).toMatchObject({ offsetX: 10, offsetY: 20 });
});

// Only an item's first paragraph lifts it out of the list. A later one joins the paragraph above, as without the image,
// which keeps its place: the paragraph above is drawn 40 px higher.
test("Backspace at the visual start of a list item's second paragraph joins it to the first and keeps the image", async () => {
    // The item's first paragraph at 2 holds "a" at 3; its second at 5 leads with the image at 6, "b" from 7.
    const editor = await mount([
        {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [paragraph(text('a')), paragraph(front(), text('b'))] }],
        },
    ]);
    place(blockDom(editor, 2), 100, 60, 600, 20);
    place(blockDom(editor, 5), 100, 100, 600, 20);
    place(figureBox(editor, 6), 110, 120);
    await act(async () => {
        editor.commands.setTextSelection(7);
    });
    await press(editor, 'Backspace');
    const [list] = editor.state.doc.toJSON().content;
    expect(list.content).toHaveLength(1);
    expect(list.content[0].content).toHaveLength(1);
    expect(editor.state.doc.nodeAt(3)?.attrs).toMatchObject({ layout: 'front', offsetX: 10, offsetY: 60 });
    expect(editor.state.doc.textContent).toBe('ab');
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 5, head: 5 });
});

// A text box is a positioned figure longer than one position: it holds its paragraphs. A paragraph led by a box and an
// image, in either order, keeps every rule above. "xy" is at 1 to 3, the second paragraph's run of eight positions
// from 5, its "abc" from 13.
const box = (attrs: object = {}) => ({
    type: 'textBox',
    attrs: { id: 'box', layout: 'front', offsetX: 10, offsetY: 20, ...attrs },
    content: [paragraph(text('Box'))],
});
const RUNS = [
    ['a box, then an image', () => [box(), front()], ['textBox:front', 'figure:front']],
    ['an image, then a box', () => [front(), box()], ['figure:front', 'textBox:front']],
] as const;
const boxText = (editor: TestEditor) => {
    let found = '';
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'textBox') found = node.textContent;
        return node.type.name !== 'textBox';
    });
    return found;
};

test.each(RUNS)('led by %s, a caret placed before the run rests after it, and ArrowLeft goes above', async (_, run) => {
    const editor = await mount([paragraph(text('xy')), paragraph(...run(), text('abc'))]);
    await act(async () => {
        editor.commands.setTextSelection(5);
    });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 13, head: 13 });
    await press(editor, 'ArrowLeft');
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 3, head: 3 });
});

test.each(
    RUNS.flatMap(([name, run, layouts]) => [
        [`Backspace at the visual start, led by ${name}`, run, layouts, 13, 'Backspace'],
        [`Delete at the end of the paragraph above, led by ${name}`, run, layouts, 3, 'Delete'],
    ]),
)('%s joins the paragraphs and keeps the run with the box’s text', async (_, run, layouts, caret, key) => {
    const editor = await mount([paragraph(text('xy')), paragraph(...run(), text('abc'))]);
    await act(async () => {
        editor.commands.setTextSelection(caret);
    });
    await press(editor, key);
    expect(blocks(editor)).toEqual([[...layouts, 'xyabc']]);
    expect(boxText(editor)).toBe('Box');
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 11, head: 11 });
});

test.each(RUNS)(
    'led by %s, Enter at the visual start opens a paragraph above, the run going down',
    async (_, run, layouts) => {
        const editor = await mount([paragraph(text('xy')), paragraph(...run(), text('abc'))]);
        await act(async () => {
            editor.commands.setTextSelection(13);
        });
        await press(editor, 'Enter');
        expect(blocks(editor)).toEqual([['xy'], [], [...layouts, 'abc']]);
        expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 15, head: 15 });
    },
);

test('a positioned box inserted mid-paragraph moves to the start, after the leading run, with its text', async () => {
    const editor = await mount(twoParagraphs());
    await act(async () => {
        editor.commands.insertContentAt(8, box({ layout: 'behind' }));
    });
    expect(blocks(editor)).toEqual([['xy'], ['figure:front', 'textBox:behind', 'abc']]);
    expect(boxText(editor)).toBe('Box');
});

test('a re-anchored box keeps its text, its card and the node selection', async () => {
    const editor = await mount(
        [paragraph(text('xy')), paragraph(box({ commentCardId: 'card' }), text('abc')), paragraph(text('z'))],
        {},
    );
    place(editor.view.dom, 100, 100, 600, 300);
    place(blockDom(editor, 0), 100, 100, 600, 20);
    place(blockDom(editor, 4), 100, 120, 600, 20);
    place(blockDom(editor, 16), 100, 140, 600, 20);
    place(figureBox(editor, 5), 110, 140);
    await act(async () => {
        editor.commands.setNodeSelection(5);
    });
    await act(async () => {
        editor.commands.moveFigure(5, { dx: 40, dy: 10 });
    });
    expect(blocks(editor)).toEqual([['xy'], ['abc'], ['textBox:front', 'z']]);
    expect(boxText(editor)).toBe('Box');
    expect(editor.state.doc.nodeAt(10)?.attrs).toMatchObject({ commentCardId: 'card', id: 'box' });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 10 });
});
