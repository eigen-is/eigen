// A chart draws the painter's SVG in the figure's frame. A grip resizes it freely and writes both sides, showing the
// size in cm while it is held, a double-click opens Edit data, and a comment on it alone quotes "Chart".
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { sampleChartSpec } = await import('@workspace/lib/charts');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { Chart } = await import('../../../../components/docs/extensions/chart');
const { commentAnchorText, nodeCommentCardId } = await import('../../../../components/docs/extensions/comment-mark');

let unmount = async () => {};
afterEach(() => unmount());

const SPEC = JSON.stringify(sampleChartSpec('column'));
const chart = (attrs: object = {}) => ({ type: 'chart', attrs: { spec: SPEC, width: 400, height: 250, ...attrs } });

// "a" at 1, the chart at 2, on a page whose text column is 600 px.
async function mount({ attrs = {}, editable = true }: { attrs?: object; editable?: boolean } = {}) {
    const edits: number[] = [];
    const editor = new Editor({
        editable,
        extensions: [
            ...getDocExtensions({ exclude: ['chart', 'comment'] }),
            Chart.configure({ onEditData: () => edits.push(editor.state.selection.from) }),
        ],
        content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, chart(attrs)] }],
        },
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
    if (!box) throw new Error('the chart did not render');
    return { editor, box, edits };
}

test("a chart draws the painter's SVG at its stored size, its labels as text, in the figure's box", async () => {
    const { box } = await mount({ attrs: { layout: 'wrap-left', caption: 'Points' } });
    const svg = box.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('400');
    expect(svg?.getAttribute('height')).toBe('250');
    expect([...(svg?.querySelectorAll('text') ?? [])].map((t) => t.textContent)).toContain('Team 1');
    expect(box.getAttribute('data-layout')).toBe('wrap-left');
    expect(box.querySelector('.figcaption')?.textContent).toBe('Points');
});

test('a chart whose spec does not parse draws the placeholder', async () => {
    const { box } = await mount({ attrs: { spec: '{' } });
    expect(box.querySelector('svg text')?.textContent).toBe("This chart can't be shown");
});

// ObjectTransform's grips listen on the document once pressed; happy-dom has no pointer capture.
async function drag(box: HTMLElement, corner: string, dx: number, dy: number) {
    const grip = [...box.querySelectorAll<HTMLElement>('.eigen-selection-handle')].find((el) =>
        corner.split(' ').every((c) => el.classList.contains(c)),
    );
    if (!grip) throw new Error(`no ${corner} grip`);
    grip.setPointerCapture = () => {};
    const at = (type: string, x: number, y: number, target: EventTarget) =>
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
    await act(async () => {
        at('pointerdown', 0, 0, grip);
    });
    await act(async () => {
        at('pointermove', dx, dy, document);
    });
    await act(async () => {
        at('pointerup', dx, dy, document);
    });
}

test('a corner grip resizes a selected chart freely and writes its width and height, and it stays selected', async () => {
    const { editor, box } = await mount();
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });

    await drag(box, '-bottom-2.5 -right-2.5', 100, -50);
    expect(editor.state.doc.nodeAt(2)?.attrs).toMatchObject({ width: 500, height: 200 });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });

    // The column caps the width, and each side keeps the floor.
    await drag(box, '-bottom-2.5 -right-2.5', 400, -400);
    expect(editor.state.doc.nodeAt(2)?.attrs).toMatchObject({ width: 600, height: 100 });
});

test('a grip held on a selected chart shows its size in cm, as the image grips do', async () => {
    const { editor, box } = await mount();
    await act(async () => {
        editor.commands.setNodeSelection(2);
    });
    const grip = box.querySelector<HTMLElement>('.eigen-selection-handle');
    if (!grip) throw new Error('no grip');
    grip.setPointerCapture = () => {};
    await act(async () => {
        grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
    });
    expect(box.querySelector('.top-full')?.textContent).toBe('10.6 × 6.6 cm');
    await act(async () => {
        document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    });
});

test("a double-click selects the chart and opens Edit data, but not a viewer's or one that can't be drawn", async () => {
    const editable = await mount();
    const dblclick = (box: HTMLElement) =>
        act(async () => {
            box.querySelector('svg')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });
    await dblclick(editable.box);
    expect(editable.edits).toEqual([2]);
    expect(editable.editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    await unmount();

    const viewer = await mount({ editable: false });
    await dblclick(viewer.box);
    expect(viewer.edits).toEqual([]);
    await unmount();

    const broken = await mount({ attrs: { spec: '{' } });
    await dblclick(broken.box);
    expect(broken.edits).toEqual([]);
});

test('a chart holds its comment card as an attribute, and a comment on it alone quotes "Chart"', async () => {
    const { editor, box } = await mount({ attrs: { commentCardId: 'card-1' } });
    const node = editor.state.doc.nodeAt(2);
    if (!node) throw new Error('no chart');
    expect(nodeCommentCardId(node)).toBe('card-1');
    expect(commentAnchorText(editor.state.doc, 2, 3)).toBe('Chart');
    expect(box.querySelector('button[aria-label="Open comment"]')).not.toBeNull();
});
