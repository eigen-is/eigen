// The Image panel follows the figure selection, so a write from the panel must keep the figure selected, and the
// panel must draw the new value though the selection didn't change. Its Width field shows and takes cm, stores px
// and clamps as the grips do.
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
async function mount(attrs: object = {}, blockOnly = false) {
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
            createElement(FigurePropertiesPanel, { editor, blockOnly, onReplaceImage: () => {} }),
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

// A band holds no float, as a docx import reads an anchored picture in a header as one on its own line.
test('in a band the panel offers alignment alone, which puts a wrapped figure on its own line', async () => {
    const editor = await mount({ layout: 'wrap-left' }, true);
    const toggles = [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
    expect(toggles.map((t) => t.getAttribute('aria-label'))).toEqual(['Align left', 'Align center', 'Align right']);

    await act(async () => toggles[0]?.click());

    expect(editor.state.doc.nodeAt(2)?.attrs).toMatchObject({ layout: 'block', alignment: 'left' });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
});

test('a Style toggle keeps the figure selected and lights the new layout', async () => {
    const editor = await mount();
    expect(styleToggles().map((t) => t.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);

    await act(async () => styleToggles()[1]?.click());

    expect(editor.state.doc.nodeAt(2)?.attrs['layout']).toBe('wrap-left');
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    expect(styleToggles().map((t) => t.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
});

// A wrapped figure is at most half the column, or nothing wraps beside it: the switch shrinks it in the same write.
test.each([
    [500, 1, 'wrap-left', 300],
    [500, 2, 'wrap-right', 300],
    [250, 1, 'wrap-left', 250],
])(
    'a %d px figure wrapped by toggle %d is %s and %d px wide, in one transaction',
    async (width, toggle, layout, fitted) => {
        const editor = await mount({ width });
        let transactions = 0;
        editor.on('transaction', ({ transaction }) => {
            if (transaction.docChanged) transactions++;
        });

        await act(async () => styleToggles()[toggle]?.click());

        expect(editor.state.doc.nodeAt(2)?.attrs).toMatchObject({ layout, width: fitted });
        expect(transactions).toBe(1);
    },
);

test('a wrapped figure set on its own line keeps its width', async () => {
    const editor = await mount({ width: 300, layout: 'wrap-left' });
    await act(async () => styleToggles()[0]?.click());
    expect(editor.state.doc.nodeAt(2)?.attrs).toMatchObject({ layout: 'block', width: 300 });
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

// Focus alone starts no draft, so a peer's write shows in the field, and the blur after it writes nothing back.
test.each([
    ['Alt text', 'alt'],
    ['Caption', 'caption'],
])('a peer writing the %s of a focused, untouched field keeps theirs', async (placeholder, attribute) => {
    const editor = await mount();
    await act(async () => field(placeholder).focus());
    await act(async () => {
        editor.view.dispatch(editor.state.tr.setNodeAttribute(2, attribute, 'Theirs'));
    });
    expect(field(placeholder).value).toBe('Theirs');

    await act(async () => field(placeholder).blur());
    expect(editor.state.doc.nodeAt(2)?.attrs[attribute]).toBe('Theirs');
});

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

test('the Width field shows the figure width in cm, to one decimal', async () => {
    await mount();
    expect(widthField().value).toBe('5.3');
    expect(widthField().parentElement?.textContent).toBe('cm');
});

test('Enter in the Width field writes the width in px and keeps the figure selected and the panel open', async () => {
    const editor = await mount();
    await type(widthField(), '8');
    await key(widthField(), 'Enter');

    expect(widthAt2(editor)).toBe(302);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    expect(widthField().value).toBe('8');
});

test('a blur writes the Width field', async () => {
    const editor = await mount();
    await type(widthField(), '8');
    await act(async () => widthField().blur());

    expect(widthAt2(editor)).toBe(302);
});

// 300 px shows as 7.9 cm, which is 298.6 px.
test.each(['Enter', 'blur'])('an untouched Width field keeps the stored width on %s', async (end) => {
    const editor = await mount({ width: 300 });
    await act(async () => widthField().focus());
    if (end === 'Enter') await key(widthField(), 'Enter');
    await act(async () => widthField().blur());

    expect(widthAt2(editor)).toBe(300);
    expect(widthField().value).toBe('7.9');
});

test.each([
    ['block', '30', 600, '15.9'],
    ['wrap-left', '30', 300, '7.9'],
    ['block', '1', 100, '2.6'],
    ['block', '6.63', 251, '6.6'],
])('a %s figure set to %s cm gets %d px, as a grip would leave it', async (layout, value, width, shown) => {
    const editor = await mount({ layout });
    await type(widthField(), value);
    await key(widthField(), 'Enter');

    expect(widthAt2(editor)).toBe(width);
    expect(widthField().value).toBe(shown);
});

test('Escape drops a typed width', async () => {
    const editor = await mount();
    await type(widthField(), '8');
    await key(widthField(), 'Escape');
    await act(async () => widthField().blur());

    expect(widthAt2(editor)).toBe(200);
    expect(widthField().value).toBe('5.3');
});

test('an emptied Width field writes nothing', async () => {
    const editor = await mount();
    await type(widthField(), '');
    await key(widthField(), 'Enter');
    await act(async () => widthField().blur());

    expect(widthAt2(editor)).toBe(200);
    expect(widthField().value).toBe('5.3');
});

test('a resize by Shift and an arrow key or by a grip shows in the Width field', async () => {
    const editor = await mount();
    await act(async () => {
        editor.view.dom.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
        );
    });
    expect(widthAt2(editor)).toBe(210);
    expect(widthField().value).toBe('5.6');

    // A grip's drag ends in this write.
    await act(async () => {
        editor.commands.command(({ tr }) => {
            setFigureAttributes(tr, 2, { width: 250 });
            return true;
        });
    });
    expect(widthField().value).toBe('6.6');
});
