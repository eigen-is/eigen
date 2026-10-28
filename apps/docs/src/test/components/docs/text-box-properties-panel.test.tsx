// The Text box panel writes each of the box's attributes and keeps the box selected, so the panel stays open. Its
// Height grows with the text until a height is typed, and Grow with text writes the height back to none.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { DEFAULT_PAGE_SETUP, getDocExtensions, mmToPx } = await import('@workspace/lib/docs/eigendoc');
const { PositionedFigures } = await import('../../../components/docs/extensions/positioned-figure');
const { TextBoxPropertiesPanel } = await import('../../../components/docs/text-box-properties-panel');

let unmount = async () => {};
afterEach(() => unmount());

// "a" at 1, the box at 2, holding "Box".
async function mount(attrs: object = {}) {
    const editor = new Editor({
        extensions: [
            ...getDocExtensions({ exclude: ['comment'] }),
            PositionedFigures.configure({
                page: () => ({
                    ...DEFAULT_PAGE_SETUP,
                    width: 800,
                    margin: { top: 100, right: 100, bottom: 100, left: 100 },
                }),
                band: false,
                note: false,
            }),
        ],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'a' },
                        {
                            type: 'textBox',
                            attrs: { id: 'b', width: 200, fill: '#ffffff', outline: '1px solid #000000', ...attrs },
                            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Box' }] }],
                        },
                    ],
                },
            ],
        },
    });
    editor.commands.setNodeSelection(2);
    const rendered = await renderInDocument(
        createElement(
            'div',
            null,
            createElement(EditorContent, { editor }),
            createElement(TextBoxPropertiesPanel, { editor }),
        ),
    );
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    return editor;
}

const box = (editor: InstanceType<typeof Editor>) => editor.state.doc.nodeAt(2)?.attrs;
const stillSelected = (editor: InstanceType<typeof Editor>) =>
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });

const button = (label: string) => {
    const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`no ${label} button`);
    return found;
};
const buttonWithText = (text: string) => {
    const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
    if (!found) throw new Error(`no ${text} button`);
    return found;
};
const checkbox = (label: string) => {
    const found = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes(label));
    const control = found?.querySelector('button[role="checkbox"]') ?? found?.previousElementSibling;
    if (!(control instanceof HTMLElement)) throw new Error(`no ${label} checkbox`);
    return control;
};

// React tracks an input's value on the instance; the prototype setter leaves its tracker stale, as a keystroke does.
const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
const typeInField = (input: HTMLInputElement, value: string) =>
    act(async () => {
        nativeValueSetter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
const cmFields = () => [...document.querySelectorAll<HTMLInputElement>('input[type="number"][step="0.01"]')];

test('the layout toggles write the layout and keep the box selected', async () => {
    const editor = await mount();
    await act(async () => button('Wrap right').click());
    expect(box(editor)?.['layout']).toBe('wrap-right');
    stillSelected(editor);
});

test('Width and Height write the box’s size in cm; Grow with text writes no height', async () => {
    const editor = await mount();
    const [width, height] = cmFields();
    if (!width || !height) throw new Error('no size fields');
    await typeInField(width, '5');
    expect(box(editor)?.['width']).toBeCloseTo(mmToPx(50), 5);
    await typeInField(height, '3');
    expect(box(editor)?.['height']).toBeCloseTo(mmToPx(30), 5);
    stillSelected(editor);
    await act(async () => checkbox('Grow with text').click());
    expect(box(editor)?.['height']).toBeNull();
    stillSelected(editor);
});

test('the outline style and weight write one outline value; vertical alignment and rounded corners write theirs', async () => {
    const editor = await mount();
    await act(async () => buttonWithText('Dashed').click());
    expect(box(editor)?.['outline']).toBe('1px dashed #000000');
    await act(async () => button('Middle').click());
    expect(box(editor)?.['verticalAlign']).toBe('middle');
    await act(async () => button('Top').click());
    expect(box(editor)?.['verticalAlign']).toBeNull();
    await act(async () => checkbox('Rounded corners').click());
    expect(box(editor)?.['rounded']).toBe(true);
    stillSelected(editor);
});

test('the padding fields write the insets in cm', async () => {
    const editor = await mount();
    const [, , sides, ends] = cmFields();
    if (!sides || !ends) throw new Error('no padding fields');
    await typeInField(sides, '0.5');
    await typeInField(ends, '0.2');
    expect(box(editor)?.['paddingX']).toBeCloseTo(mmToPx(5), 5);
    expect(box(editor)?.['paddingY']).toBeCloseTo(mmToPx(2), 5);
    stillSelected(editor);
});
