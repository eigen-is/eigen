// A block figure's box is the column's width: a click in its empty space beside the image places the caret on that
// side, and the image itself still selects the node. A selected figure still drags, and a drag that empties the
// figure's paragraph removes it. Shift and the arrow keys resize a selected figure within the text column.
import { afterEach, expect, test } from 'bun:test';
import { NodeSelection } from '@tiptap/pm/state';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { Figure } = await import('../../../../components/docs/extensions/figure');

let unmount = async () => {};
afterEach(() => unmount());

const figure = { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 200 } };
const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
const text = (t: string) => ({ type: 'text', text: t });

// By default "a" at 1, the figure at 2, "b" at 3: the image box spans x 200 to 400 in the 600 px wide figure box,
// on a page whose text column is 600 px.
async function mount(content: object[] = [paragraph(text('a'), figure, text('b'))]) {
    const editor = new Editor({
        extensions: [...getDocExtensions({ exclude: ['figure', 'comment'] }), Figure],
        content: { type: 'doc', content },
    });
    const rendered = await renderInDocument(
        createElement('div', { 'data-document': '', style: { padding: 0 } }, createElement(EditorContent, { editor })),
    );
    const page = document.querySelector('[data-document]');
    if (page) Object.defineProperty(page, 'clientWidth', { value: 600 });
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

test.each([
    ['block', 595, 'ArrowRight', 600],
    ['wrap-left', 295, 'ArrowRight', 300],
    ['block', 105, 'ArrowLeft', 100],
])('a %s figure of %d px, Shift-%s twice, stops at %d px', async (layout, width, key, limit) => {
    const { editor } = await mount([paragraph(text('a'), { ...figure, attrs: { ...figure.attrs, layout, width } })]);
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });

    await press(editor, key);
    await press(editor, key);
    expect(widthAt2(editor)).toBe(limit);
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

// Shift+ArrowRight from before a figure selects it as text, and the next press extends that selection.
test('Shift and an arrow key leave a text selection of a figure to the browser', async () => {
    const { editor } = await mount();
    await act(async () => {
        editor.commands.setTextSelection({ from: 2, to: 3 });
    });

    await press(editor, 'ArrowRight');
    expect(widthAt2(editor)).toBe(200);
});
