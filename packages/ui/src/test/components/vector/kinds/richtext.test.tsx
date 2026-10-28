// The in-place editor fills the whole shape, but the text in it may fill only part. A press on the rest must keep the
// session: the caret stays in the text, so typing, Escape and the editor's keymap keep working.
import { afterEach, expect, test } from 'bun:test';
import type { VectorTextualElement } from '@workspace/lib/vector';
import { DEFAULT_ELEMENT_PROPS, ELEMENT_KINDS, VECTOR_STYLE_DEFAULTS } from '@workspace/lib/vector';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { RichTextInPlaceEditor } = await import('../../../../components/vector/kinds/richtext');

const shape: VectorTextualElement = {
    ...DEFAULT_ELEMENT_PROPS,
    ...ELEMENT_KINDS.rectangle.defaults(VECTOR_STYLE_DEFAULTS),
    id: 'r1',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 400,
    height: 200,
    angle: 0,
    index: 'a0',
    html: '<p>Label</p>',
};

let unmount = async () => {};
afterEach(() => unmount());

async function render() {
    const rendered = await renderInDocument(
        createElement(RichTextInPlaceEditor, { element: shape, onChange: () => {}, onExit: () => {} }),
    );
    unmount = rendered.unmount;
    const box = rendered.container.firstElementChild;
    const text = rendered.container.querySelector('.ProseMirror');
    if (!(box instanceof HTMLElement) || !(text instanceof HTMLElement)) throw new Error('the editor did not mount');
    return { box, text };
}

async function press(target: Element): Promise<boolean> {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => {
        target.dispatchEvent(event);
    });
    return event.defaultPrevented;
}

test('a press in the shape away from its text keeps the focus in the text', async () => {
    const { box, text } = await render();
    text.blur();
    expect(await press(box)).toBe(true);
    expect(document.activeElement).toBe(text);
    const caret = document.getSelection();
    expect([caret?.anchorNode?.textContent, caret?.anchorOffset, caret?.isCollapsed]).toEqual(['Label', 5, true]);
});

test('a press on the text itself is left to the editor, which places the caret there', async () => {
    const { text } = await render();
    expect(await press(text)).toBe(false);
});

test("a press in the floating toolbar, which tiptap mounts beside the text, is left to the toolbar's own controls", async () => {
    const { text } = await render();
    const toolbar = document.createElement('div');
    text.after(toolbar);
    expect(await press(toolbar)).toBe(false);
});
