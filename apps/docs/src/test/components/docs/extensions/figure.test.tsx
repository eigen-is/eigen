// A block figure's box is the column's width: a click in its empty space beside the image places the caret on that
// side, and the image itself still selects the node.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { Figure } = await import('../../../../components/docs/extensions/figure');

let unmount = async () => {};
afterEach(() => unmount());

// "a" at 1, the figure at 2, "b" at 3: the image box spans x 200 to 400 in the 600 px wide figure box.
async function mount() {
    const editor = new Editor({
        extensions: [...getDocExtensions({ exclude: ['figure', 'comment'] }), Figure],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'a' },
                        { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 200 } },
                        { type: 'text', text: 'b' },
                    ],
                },
            ],
        },
    });
    ({ unmount } = await renderInDocument(createElement(EditorContent, { editor })));
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
