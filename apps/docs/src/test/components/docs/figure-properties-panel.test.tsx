// The Image panel follows the figure selection, so a write from the panel must keep the figure selected, and the
// panel must draw the new value though the selection didn't change. Its Width field clamps as the grips do.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { getDocExtensions, setFigureAttributes } = await import('@workspace/lib/docs/eigendoc');
const { Figure } = await import('../../../components/docs/extensions/figure');
const { FigurePropertiesPanel } = await import('../../../components/docs/figure-properties-panel');

let unmount = async () => {};
afterEach(() => unmount());

// "a" at 1, the figure at 2, on a page whose text column is 600 px.
async function mount(attrs: object = {}) {
    const editor = new Editor({
        extensions: [...getDocExtensions({ exclude: ['figure', 'comment'] }), Figure],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'a' },
                        { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 200, ...attrs } },
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
            createElement(
                'div',
                { 'data-document': '', style: { padding: 0 } },
                createElement(EditorContent, { editor }),
            ),
            createElement(FigurePropertiesPanel, { editor, onReplaceImage: () => {} }),
        ),
    );
    const page = document.querySelector('[data-document]');
    if (page) Object.defineProperty(page, 'clientWidth', { value: 600 });
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    return editor;
}

const field = (placeholder: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
    if (!input) throw new Error(`no ${placeholder} field`);
    return input;
};

// React tracks an input's value on the instance; the prototype setter leaves its tracker stale, as a keystroke does.
const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

// The Style toggles, own line, wrap left and wrap right, come before Align's.
const styleToggles = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].slice(0, 3);

test('a Style toggle keeps the figure selected and lights the new layout', async () => {
    const editor = await mount();
    expect(styleToggles().map((t) => t.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);

    await act(async () => styleToggles()[1]?.click());

    expect(editor.state.doc.nodeAt(2)?.attrs['layout']).toBe('wrap-left');
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    expect(styleToggles().map((t) => t.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
});

test.each([
    ['Alt text', 'alt', 'A chart'],
    ['Caption', 'caption', 'Figure 1'],
])('Enter in the %s field writes it and keeps the figure selected', async (placeholder, attribute, value) => {
    const editor = await mount();
    const input = field(placeholder);

    await act(async () => {
        input.focus();
        nativeValueSetter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(editor.state.doc.nodeAt(2)?.attrs[attribute]).toBe(value);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(value);
});

// A collaborator typing above the figure moves it, and the selection with it.
test.each(['Alt text', 'Caption'])(
    'an edit above the figure leaves a half-typed %s and its focus alone',
    async (placeholder) => {
        const editor = await mount();
        const input = field(placeholder);
        await act(async () => {
            input.focus();
            nativeValueSetter?.call(input, 'A ch');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });

        await act(async () => {
            editor.view.dispatch(editor.state.tr.insertText('x', 1));
        });

        expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 3 });
        expect(document.activeElement).toBe(field(placeholder));
        expect(field(placeholder).value).toBe('A ch');
    },
);

const widthField = () => {
    const input = document.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error('no Width field');
    return input;
};
const widthAt2 = (editor: InstanceType<typeof Editor>) => editor.state.doc.nodeAt(2)?.attrs['width'];

const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
        input.focus();
        nativeValueSetter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
const key = (input: HTMLInputElement, key: string) =>
    act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });

test('the Width field shows the figure width in px', async () => {
    await mount();
    expect(widthField().value).toBe('200');
    expect(widthField().parentElement?.textContent).toBe('px');
});

test('Enter in the Width field writes the width and keeps the figure selected and the panel open', async () => {
    const editor = await mount();
    await type(widthField(), '320');
    await key(widthField(), 'Enter');

    expect(widthAt2(editor)).toBe(320);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    expect(widthField().value).toBe('320');
});

test('a blur writes the Width field', async () => {
    const editor = await mount();
    await type(widthField(), '320');
    await act(async () => widthField().blur());

    expect(widthAt2(editor)).toBe(320);
});

test.each([
    ['block', '900', 600],
    ['wrap-left', '900', 300],
    ['block', '20', 100],
    ['block', '250.6', 251],
])('a %s figure set to %s px gets %d px, as a grip would leave it', async (layout, value, width) => {
    const editor = await mount({ layout });
    await type(widthField(), value);
    await key(widthField(), 'Enter');

    expect(widthAt2(editor)).toBe(width);
    expect(widthField().value).toBe(String(width));
});

test('Escape drops a typed width', async () => {
    const editor = await mount();
    await type(widthField(), '320');
    await key(widthField(), 'Escape');
    await act(async () => widthField().blur());

    expect(widthAt2(editor)).toBe(200);
    expect(widthField().value).toBe('200');
});

test('an emptied Width field writes nothing', async () => {
    const editor = await mount();
    await type(widthField(), '');
    await key(widthField(), 'Enter');
    await act(async () => widthField().blur());

    expect(widthAt2(editor)).toBe(200);
    expect(widthField().value).toBe('200');
});

test('a resize by Shift and an arrow key or by a grip shows in the Width field', async () => {
    const editor = await mount();
    await act(async () => {
        editor.view.dom.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
        );
    });
    expect(widthField().value).toBe('210');

    // A grip's drag ends in this write.
    await act(async () => {
        editor.commands.command(({ tr }) => {
            setFigureAttributes(tr, 2, { width: 250 });
            return true;
        });
    });
    expect(widthField().value).toBe('250');
});
