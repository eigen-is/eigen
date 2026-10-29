// A block figure's box is the column's width: a click in its empty space beside the image places the caret on that
// side, and the image itself still selects the node. A selected figure still drags, and a drag that empties the
// figure's paragraph removes it. Shift and the arrow keys resize a selected figure within the text column, and a grip
// shows the size in cm while it is held, its drag in the page's pixels at any scale. A drag the selection leaves drops
// its preview.
import { afterEach, expect, test } from 'bun:test';
import { NodeSelection } from '@tiptap/pm/state';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { DEFAULT_PAGE_SETUP, getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { Figure } = await import('../../../../components/docs/extensions/figure');
const { fitFigureBox, setAspectLocked } = await import('../../../../components/docs/extensions/figure-frame');
const { PositionedFigures } = await import('../../../../components/docs/extensions/positioned-figure');

let unmount = async () => {};
afterEach(() => unmount());

const figure = { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 200 } };
const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });

// By default "a" at 1, the figure at 2, "b" at 3: the image box spans x 200 to 400 in the 600 px wide figure box,
// on a page whose text column is 600 px.
async function mount(content: object[] = [paragraph(text('a'), figure, text('b'))], pageless = false, columnPx = 600) {
    const editor = new Editor({
        extensions: [
            ...getDocExtensions({ exclude: ['figure', 'comment'] }),
            Figure,
            // An 800 px paper with 100 px margins.
            PositionedFigures.configure({
                page: () => ({
                    ...DEFAULT_PAGE_SETUP,
                    width: 800,
                    margin: { top: 100, right: 100, bottom: 100, left: 100 },
                    pageless,
                }),
            }),
        ],
        content: { type: 'doc', content },
    });
    const rendered = await renderInDocument(
        createElement('div', { 'data-document': '', style: { padding: 0 } }, createElement(EditorContent, { editor })),
    );
    const page = document.querySelector('[data-document]');
    if (page) Object.defineProperty(page, 'clientWidth', { value: columnPx });
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    await act(async () => {});
    const box = editor.view.dom.querySelector<HTMLElement>('.figure');
    const image = box?.firstElementChild;
    if (!box || !image) throw new Error('the figure did not render');
    image.getBoundingClientRect = () => DOMRect.fromRect({ x: 200, y: 0, width: 200, height: 100 });

    // ProseMirror's mouseup asks handleClickOn of the clicked figure, the innermost node, before it selects it.
    const click = (target: Element, clientX: number) => {
        const event = new MouseEvent('mouseup', { clientX, clientY: 50 });
        target.dispatchEvent(event);
        const figure = editor.state.doc.nodeAt(2);
        if (!figure) throw new Error('no figure at 2');
        return editor.view.someProp('handleClickOn', (handle) => handle(editor.view, 2, figure, 2, event, true));
    };
    return { editor, box, image, click };
}

test('a click left of the image puts the caret before the figure, right of it after the figure', async () => {
    const { editor, box, click } = await mount();

    expect(click(box, 20)).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 2, head: 2 });

    expect(click(box, 580)).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 3, head: 3 });
});

test('a click on the image is left to ProseMirror, which selects the node', async () => {
    const { editor, image, click } = await mount();
    const before = editor.state.selection.toJSON();

    expect(click(image, 300)).toBeFalsy();
    expect(editor.state.selection.toJSON()).toEqual(before);
});

test('a press on a selected figure is not prevented, so the browser can start its drag', async () => {
    const { editor, image } = await mount();
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });

    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 300, clientY: 50 });
    image.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
});

// ProseMirror's move of the figure at `from` to `to`: the dragged node replaced, inserted at the drop point, uiEvent drop.
async function drop(content: object[], from: number, to: number) {
    const { editor } = await mount(content);
    const dragged = NodeSelection.create(editor.state.doc, from);
    await act(async () => {
        editor.view.dispatch(editor.state.tr.setSelection(dragged));
        const tr = editor.state.tr;
        dragged.replace(tr);
        const pos = tr.mapping.map(to);
        tr.replaceRangeWith(pos, pos, dragged.node);
        editor.view.dispatch(tr.setMeta('uiEvent', 'drop'));
    });
    return editor
        .getJSON()
        .content?.map((block) => block.content?.map((node) => ('text' in node ? node.text : node.type)) ?? []);
}

test('a figure dragged out of a paragraph of its own takes the paragraph with it', async () => {
    // The figure at 4, the end of "b" at 8.
    const blocks = await drop([paragraph(text('a')), paragraph(figure), paragraph(text('b'))], 4, 8);
    expect(blocks).toEqual([['a'], ['b', 'figure']]);
});

test('a figure dragged out of a paragraph with text leaves the text', async () => {
    // The figure at 5, the end of "b" at 9.
    const blocks = await drop([paragraph(text('a')), paragraph(text('x'), figure), paragraph(text('b'))], 5, 9);
    expect(blocks).toEqual([['a'], ['x'], ['b', 'figure']]);
});

// The box takes 10rem or all its container gives, so a narrow table cell keeps its width; one with no alt text shows.
test('a picture that fails to load, a WMF or EMF, widens to read its alt text and stands a line tall', async () => {
    const small = { type: 'figure', attrs: { src: 'data:image/x-wmf;base64,', alt: 'Organisation chart', width: 40 } };
    const { box, image } = await mount([paragraph(small)]);
    const img = box.querySelector('img');
    if (!img) throw new Error('no img');
    const classes = () => [box, image, img].map((el) => el.className.split(' ').filter((c) => c.startsWith('min-')));
    expect(classes()).toEqual([[], [], []]);

    await act(async () => {
        img.dispatchEvent(new Event('error'));
    });
    expect(classes()).toEqual([['min-w-[min(10rem,100%)]'], ['min-w-[min(10rem,100%)]'], ['min-w-full', 'min-h-10']]);
});

// A replaced image loads with no width, and the Image panel stays open only while the figure stays selected.
test('a width written by the node view keeps the figure selected', async () => {
    const unsized = { type: 'figure', attrs: { src: 'data:image/png;base64,' } };
    const { editor, box } = await mount([paragraph(text('a'), unsized)]);
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });

    await act(async () => {
        box.querySelector('img')?.dispatchEvent(new Event('load'));
    });
    expect(editor.state.doc.nodeAt(2)?.attrs['width']).toBe(600);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
});

test('a grip held on a selected figure shows its size in cm', async () => {
    const wide = { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 300 } };
    const { editor, box } = await mount([paragraph(text('a'), wide)]);
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });
    const img = box.querySelector('img');
    if (!img) throw new Error('no img');
    Object.defineProperties(img, { naturalWidth: { value: 600 }, naturalHeight: { value: 300 } });
    await act(async () => {
        img.dispatchEvent(new Event('load'));
    });

    const grip = box.querySelector('.eigen-selection-handle');
    if (!grip) throw new Error('no grip');
    // happy-dom has no pointer capture.
    Object.defineProperty(grip, 'setPointerCapture', { value: () => {} });
    await act(async () => {
        grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
    });
    expect(box.querySelector('.top-full')?.textContent).toBe('7.9 × 4 cm');
    await act(async () => {
        document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    });
});

// The page draws scaled below its width (DOCS.md), and a figure stores its width in the page's own pixels.
test.each([
    [1, 250],
    [0.5, 300],
])('a grip dragged 50 screen px on a page drawn at %p makes a 200 px figure %d px wide', async (scale, width) => {
    const { editor, box, image } = await mount([paragraph(text('a'), figure)]);
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });
    const img = box.querySelector('img');
    if (!img) throw new Error('no img');
    Object.defineProperties(img, { naturalWidth: { value: 600 }, naturalHeight: { value: 300 } });
    await act(async () => {
        img.dispatchEvent(new Event('load'));
    });
    Object.defineProperty(editor.view.dom, 'offsetWidth', { value: 600 });
    editor.view.dom.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: 0, width: 600 * scale, height: 100 * scale });
    image.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 200 * scale, height: 100 * scale });

    const grip = box.querySelectorAll('.eigen-selection-handle')[3];
    if (!grip) throw new Error('no south-east grip');
    Object.defineProperty(grip, 'setPointerCapture', { value: () => {} });
    await act(async () => {
        grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 100 }));
    });
    await act(async () => {
        document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 150 }));
        document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 150 }));
    });
    expect(editor.state.doc.nodeAt(2)?.attrs['width']).toBe(width);
});

// With Keep aspect ratio off, every grip is free, and a drag that leaves the picture's ratio stores the height it drew.
test('an unlocked grip stretches a picture and stores its height', async () => {
    const { editor, box } = await mount([paragraph(text('a'), figure)]);
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });
    const img = box.querySelector('img');
    if (!img) throw new Error('no img');
    Object.defineProperties(img, { naturalWidth: { value: 600 }, naturalHeight: { value: 300 } });
    await act(async () => {
        img.dispatchEvent(new Event('load'));
        setAspectLocked(editor, 'figure', false);
    });
    const grip = box.querySelectorAll('.eigen-selection-handle')[3];
    if (!grip) throw new Error('no south-east grip');
    Object.defineProperty(grip, 'setPointerCapture', { value: () => {} });
    await act(async () => {
        grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 100 }));
    });
    await act(async () => {
        document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 150 }));
        document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 150 }));
    });
    expect(editor.state.doc.nodeAt(2)?.attrs).toMatchObject({ width: 250, height: 100 });
});

// An image has no floor but a pixel a side, so a grip can draw a thin divider, as a docx brings one, or a small icon.
test('an unlocked grip keeps each side of an image to a pixel', () => {
    expect(fitFigureBox({ x: 0, y: 0, width: 40, height: 4.4, angle: 0 }, 600, null)).toEqual({
        width: 40,
        height: 4,
    });
    expect(fitFigureBox({ x: 0, y: 0, width: 0, height: 20, angle: 0 }, 600, null)).toEqual({ width: 1, height: 20 });
    expect(fitFigureBox({ x: 0, y: 0, width: 300, height: 0, angle: 0 }, 600, null)).toEqual({ width: 300, height: 1 });
});

test('a stored height draws the picture stretched to its box', async () => {
    const stretched = { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 200, height: 50 } };
    const { box } = await mount([paragraph(text('a'), stretched)]);
    const img = box.querySelector('img');
    expect([img?.style.width, img?.style.aspectRatio]).toEqual(['200px', '4 / 1']);
});

test('a figure deselected mid-drag draws at its stored width again', async () => {
    const { editor, box } = await mount([paragraph(text('a'), figure)]);
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });
    const img = box.querySelector('img');
    if (!img) throw new Error('no img');
    Object.defineProperties(img, { naturalWidth: { value: 600 }, naturalHeight: { value: 300 } });
    await act(async () => {
        img.dispatchEvent(new Event('load'));
    });
    const grip = box.querySelectorAll('.eigen-selection-handle')[3];
    if (!grip) throw new Error('no south-east grip');
    Object.defineProperty(grip, 'setPointerCapture', { value: () => {} });
    await act(async () => {
        grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 100 }));
        document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 150 }));
    });
    expect(img.style.width).toBe('250px');
    await act(async () => {
        editor.commands.setTextSelection(1);
    });
    expect(img.style.width).toBe('200px');
    expect(editor.state.doc.nodeAt(2)?.attrs['width']).toBe(200);
});

const press = (editor: InstanceType<typeof Editor>, key: string) =>
    act(async () => {
        editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true }));
    });
const widthAt2 = (editor: InstanceType<typeof Editor>) => editor.state.doc.nodeAt(2)?.attrs['width'];

test('Shift and an arrow key resize a selected figure in steps, and it stays selected', async () => {
    const { editor } = await mount();
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });

    await press(editor, 'ArrowRight');
    expect(widthAt2(editor)).toBe(210);
    await press(editor, 'ArrowUp');
    expect(widthAt2(editor)).toBe(220);
    await press(editor, 'ArrowLeft');
    await press(editor, 'ArrowDown');
    expect(widthAt2(editor)).toBe(200);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
});

test('Shift and an arrow key keep a stretched figure in shape', async () => {
    const stretched = { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 200, height: 50 } };
    const { editor } = await mount([paragraph(text('a'), stretched)]);
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });
    await press(editor, 'ArrowRight');
    expect(editor.state.doc.nodeAt(2)?.attrs).toMatchObject({ width: 210, height: 53 });
});

test.each([
    ['block', 595, 'ArrowRight', 600],
    ['wrap-left', 295, 'ArrowRight', 300],
    ['block', 15, 'ArrowLeft', 1],
])('a %s figure of %d px, Shift-%s twice, stops at %d px', async (layout, width, key, limit) => {
    const { editor } = await mount([paragraph(text('a'), { ...figure, attrs: { ...figure.attrs, layout, width } })]);
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });

    await press(editor, key);
    await press(editor, key);
    expect(widthAt2(editor)).toBe(limit);
});

// A page-less doc's column is the reader's, so a block figure grows past it up to the paper, and a wrap keeps half of the
// page map's column, whatever the column on screen.
test.each([
    ['block', 795, 800],
    ['wrap-left', 295, 300],
])('on a page-less doc, a %s figure of %d px, Shift-ArrowRight twice, stops at %d px', async (layout, width, limit) => {
    const { editor } = await mount(
        [paragraph(text('a'), { ...figure, attrs: { ...figure.attrs, layout, width } })],
        true,
        // The reader's Wide column on screen.
        1056,
    );
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });

    await press(editor, 'ArrowRight');
    await press(editor, 'ArrowRight');
    expect(widthAt2(editor)).toBe(limit);
});

// A page-less doc's wide image shrinks to the room beside its column, so it draws narrower than it is stored, and a
// grip's travel counts in stored px all the same.
test('a grip on a figure drawn at 350 px of its stored 700 px moves it twice its screen travel', async () => {
    const wide = { ...figure, attrs: { ...figure.attrs, width: 700 } };
    const { editor, box, image } = await mount([paragraph(text('a'), wide)], true);
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });
    const img = box.querySelector('img');
    if (!img) throw new Error('no img');
    Object.defineProperties(img, { naturalWidth: { value: 1400 }, naturalHeight: { value: 700 } });
    await act(async () => {
        img.dispatchEvent(new Event('load'));
    });
    image.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 350, height: 175 });

    const grip = box.querySelectorAll('.eigen-selection-handle')[3];
    if (!grip) throw new Error('no south-east grip');
    Object.defineProperty(grip, 'setPointerCapture', { value: () => {} });
    await act(async () => {
        grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 100 }));
    });
    await act(async () => {
        document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 140 }));
        document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 140 }));
    });
    expect(widthAt2(editor)).toBe(780);
});

// A figure with no width draws at its image's own width, capped at the column.
test('Shift and an arrow key resize a figure with no width from the width it is drawn at', async () => {
    const unsized = { type: 'figure', attrs: { src: 'data:image/png;base64,' } };
    const { editor, box } = await mount([paragraph(text('a'), unsized)]);
    Object.defineProperty(box.querySelector('img'), 'clientWidth', { value: 250 });
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });

    await press(editor, 'ArrowRight');
    expect(widthAt2(editor)).toBe(260);
});

// A collaborator can store any width: one that isn't a positive number resizes from the drawn width, as no width does.
test.each([['wide'], [-50]])(
    'Shift and an arrow key resize a figure stored %p wide to a finite width',
    async (width) => {
        const junk = { type: 'figure', attrs: { src: 'data:image/png;base64,', width } };
        const { editor, box } = await mount([paragraph(text('a'), junk)]);
        Object.defineProperty(box.querySelector('img'), 'clientWidth', { value: 250 });
        await act(async () => {
            editor.commands.setNodeSelection(2);
        });

        await press(editor, 'ArrowRight');
        expect(widthAt2(editor)).toBe(260);
    },
);

// Shift+ArrowRight from before a figure selects it as text, and the next press extends that selection.
test('Shift and an arrow key leave a text selection of a figure to the browser', async () => {
    const { editor } = await mount();
    await act(async () => {
        editor.commands.setTextSelection({ from: 2, to: 3 });
    });

    await press(editor, 'ArrowRight');
    expect(widthAt2(editor)).toBe(200);
});

// A figure in front of or behind the text: "a" at 1, the figure leading the second paragraph at 4, "b" at 5.
const positioned = (attrs: object = {}) => [
    paragraph(text('a')),
    paragraph(
        { ...figure, attrs: { ...figure.attrs, layout: 'front', offsetX: 30, offsetY: 40, ...attrs } },
        text('b'),
    ),
];

// The page drawn at `scale`: the column from x 100, the first paragraph from y 100 and the second from y 120, the
// image 200 by 100 page px at its offsets.
async function mountPositioned(scale = 1, attrs: object = {}) {
    const mounted = await mount(positioned(attrs));
    const { editor, box } = mounted;
    const at = (element: Element | null | undefined, x: number, y: number, width: number, height: number) => {
        if (element) element.getBoundingClientRect = () => DOMRect.fromRect({ x, y, width, height });
    };
    Object.defineProperty(editor.view.dom, 'offsetWidth', { value: 600 });
    at(editor.view.dom, 100, 100, 600 * scale, 300 * scale);
    const first = editor.view.nodeDOM(0);
    at(first instanceof Element ? first : null, 100, 100, 600 * scale, 20 * scale);
    const second = editor.view.nodeDOM(3);
    at(second instanceof Element ? second : null, 100, 100 + 20 * scale, 600 * scale, 20 * scale);
    for (const element of [box, box.firstElementChild])
        at(element, 100 + 30 * scale, 100 + 60 * scale, 200 * scale, 100 * scale);
    const img = box.querySelector('img');
    if (!img) throw new Error('no img');
    Object.defineProperties(img, { naturalWidth: { value: 400 }, naturalHeight: { value: 200 } });
    await act(async () => {
        img.dispatchEvent(new Event('load'));
    });
    return mounted;
}

const pointer = (target: EventTarget, type: string, clientX: number, clientY: number) =>
    act(async () => {
        target.dispatchEvent(
            new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX, clientY }),
        );
    });

// Where a positioned box draws. The node view writes its left and width as custom properties, which one rule draws and
// a page-less doc's rule clamps into its column, and its top inline.
const placeOf = (box: HTMLElement) => ({
    left: box.style.getPropertyValue('--figure-left'),
    width: box.style.getPropertyValue('--figure-width'),
});

test("a positioned figure's wrapper is its box at its offsets, which the browser's drag and drop never moves", async () => {
    const { box } = await mount(positioned());
    expect(placeOf(box)).toEqual({ left: '30px', width: '200px' });
    expect(box.style.top).toBe('40px');
    // Nothing inline for a page-less doc's rule to beat.
    expect([box.style.left, box.style.width]).toEqual(['', '']);
    expect(box.hasAttribute('data-drag-handle')).toBe(false);
    expect(box.getAttribute('draggable')).not.toBe('true');
});

test('a selected positioned figure draws its grips in a sibling above both layers, at its place', async () => {
    const { editor, box } = await mountPositioned();
    await act(async () => {
        editor.commands.setNodeSelection(4);
    });
    const chrome = box.nextElementSibling;
    if (!(chrome instanceof HTMLElement)) throw new Error('no chrome');
    expect(chrome.className).toContain('z-2');
    expect(placeOf(chrome)).toEqual({ left: '30px', width: '200px' });
    // Its height follows its drawn width, so its ring fits a figure a page-less column draws narrower.
    expect(chrome.style.height).toBe('');
    expect(chrome.style.aspectRatio).toBe('200 / 100');
    expect(chrome.querySelectorAll('.eigen-selection-handle').length).toBeGreaterThan(0);
    expect(box.querySelectorAll('.eigen-selection-handle').length).toBe(0);
});

// The drag's screen travel divides by the page's scale, and the drop writes once.
test.each([
    [1, 80, 60],
    [0.5, 130, 80],
])('a drag of 50 by 20 screen px on a page drawn at %p moves the figure to %d, %d', async (scale, offsetX, offsetY) => {
    const { editor, box } = await mountPositioned(scale);
    await act(async () => {
        editor.commands.setNodeSelection(4);
    });
    const chrome = box.nextElementSibling;
    if (!chrome) throw new Error('no chrome');
    await pointer(chrome, 'pointerdown', 200, 200);
    await pointer(document, 'pointermove', 250, 220);
    expect(placeOf(box).left).toBe(`${30 + 50 / scale}px`);
    expect(editor.state.doc.nodeAt(4)?.attrs['offsetX']).toBe(30);
    await pointer(document, 'pointerup', 250, 220);
    expect(editor.state.doc.nodeAt(4)?.attrs).toMatchObject({ offsetX, offsetY });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 4 });
});

// The page scrolls 100 px under the pointer mid-drag: the preview moves with its paragraph, and so does the drop.
test('a drop lands where the preview draws it, though the page scrolled during the drag', async () => {
    const { editor, box } = await mountPositioned();
    await act(async () => {
        editor.commands.setNodeSelection(4);
    });
    const chrome = box.nextElementSibling;
    if (!chrome) throw new Error('no chrome');
    await pointer(chrome, 'pointerdown', 200, 200);
    await pointer(document, 'pointermove', 250, 220);
    for (const element of [editor.view.dom, editor.view.nodeDOM(0), editor.view.nodeDOM(3), box, box.firstElementChild])
        if (element instanceof Element) {
            const { x, y, width, height } = element.getBoundingClientRect();
            element.getBoundingClientRect = () => DOMRect.fromRect({ x, y: y - 100, width, height });
        }
    await pointer(document, 'pointerup', 250, 220);
    expect(editor.state.doc.nodeAt(4)?.attrs).toMatchObject({ offsetX: 80, offsetY: 60 });
});

test('a press on a front figure that is not selected selects it, and the same gesture drags it', async () => {
    const { editor, box } = await mountPositioned();
    await pointer(box.querySelector('img') ?? box, 'pointerdown', 200, 200);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 4 });
    await pointer(document, 'pointermove', 210, 200);
    await pointer(document, 'pointerup', 210, 200);
    expect(editor.state.doc.nodeAt(4)?.attrs['offsetX']).toBe(40);
});

test('Escape drops a drag in progress', async () => {
    const { editor, box } = await mountPositioned();
    await pointer(box, 'pointerdown', 200, 200);
    await pointer(document, 'pointermove', 250, 200);
    await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await pointer(document, 'pointerup', 250, 200);
    expect(placeOf(box).left).toBe('30px');
    expect(editor.state.doc.nodeAt(4)?.attrs['offsetX']).toBe(30);
});

// The north-west grip keeps the bottom right corner where it is, so the offsets follow the size.
test('a north-west grip that grows a positioned figure moves its offsets by the growth', async () => {
    const { editor, box } = await mountPositioned();
    await act(async () => {
        editor.commands.setNodeSelection(4);
    });
    const grip = box.nextElementSibling?.querySelector('.eigen-selection-handle');
    if (!grip) throw new Error('no north-west grip');
    Object.defineProperty(grip, 'setPointerCapture', { value: () => {} });
    await pointer(grip, 'pointerdown', 130, 160);
    await pointer(document, 'pointermove', 80, 135);
    await pointer(document, 'pointerup', 80, 135);
    expect(editor.state.doc.nodeAt(4)?.attrs).toMatchObject({ width: 250, offsetX: -20, offsetY: 15 });
});

// Its paragraph starts at the paper's x 100: at -80 the image has 20 px of paper to its west, at 490 10 px to its east.
// A grip grows it no further, so the opposite edge stays put in the preview and in the commit alike.
test.each([
    ['north-west', 0, -80, -50, 220, -100, 30],
    ['south-east', 3, 490, 50, 210, 490, 40],
])(
    'a %s grip that would grow a positioned figure past the paper stops at its edge',
    async (_grip, index, offsetX, dx, width, x, y) => {
        const { editor, box } = await mountPositioned(1, { offsetX });
        await act(async () => {
            editor.commands.setNodeSelection(4);
        });
        const grip = box.nextElementSibling?.querySelectorAll('.eigen-selection-handle')[index];
        if (!grip) throw new Error('no grip');
        Object.defineProperty(grip, 'setPointerCapture', { value: () => {} });
        await pointer(grip, 'pointerdown', 200, 200);
        await pointer(document, 'pointermove', 200 + dx, 200 + dx / 2);
        expect(placeOf(box)).toEqual({ left: `${x}px`, width: `${width}px` });
        await pointer(document, 'pointerup', 200 + dx, 200 + dx / 2);
        expect(editor.state.doc.nodeAt(4)?.attrs).toMatchObject({ width, offsetX: x, offsetY: y });
    },
);

test('Shift and an arrow key resize a positioned figure up to the paper, not the column', async () => {
    const { editor } = await mount(positioned({ width: 795 }));
    await act(async () => {
        editor.commands.setNodeSelection(4);
    });
    await press(editor, 'ArrowRight');
    await press(editor, 'ArrowRight');
    expect(editor.state.doc.nodeAt(4)?.attrs['width']).toBe(800);
});

// Its paragraph starts at the paper's x 100, so at x 490 a 200 px image ends 10 px short of the 800 px paper's edge.
test('Shift and an arrow key that grow a positioned figure past the paper move it back on', async () => {
    const { editor } = await mountPositioned(1, { offsetX: 490 });
    await act(async () => {
        editor.commands.setNodeSelection(4);
    });
    await press(editor, 'ArrowRight');
    await press(editor, 'ArrowRight');
    expect(editor.state.doc.nodeAt(4)?.attrs).toMatchObject({ width: 220, offsetX: 480 });
});
