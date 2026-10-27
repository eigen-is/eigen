// The Image panel follows the figure selection, so a write from the panel must keep the figure selected, and the
// panel must draw the new value though the selection didn't change. Its W and H fields show and take cm, store px
// and clamp as the grips do, coupled while Keep aspect ratio is on.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { DEFAULT_PAGE_SETUP, getDocExtensions, setFigureAttributes } = await import('@workspace/lib/docs/eigendoc');
const { Figure } = await import('../../../components/docs/extensions/figure');
const { PositionedFigures } = await import('../../../components/docs/extensions/positioned-figure');
const { FigurePropertiesPanel } = await import('../../../components/docs/figure-properties-panel');

let unmount = async () => {};
afterEach(() => unmount());

// "a" at 1, the figure at 2, on a page whose text column is 600 px. `band` and `note` are a band's and a note's
// editor, where every figure draws in line; `inCell` puts the paragraph in a table cell, its figure at 5. The picture
// is 400 x 200 px of its own, as its <img> reports once loaded.
async function mount(attrs: object = {}, { band = false, note = false, inCell = false } = {}) {
    const paragraph = {
        type: 'paragraph',
        content: [
            { type: 'text', text: 'a' },
            { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 200, ...attrs } },
        ],
    };
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
                }),
                band,
                note,
            }),
        ],
        content: {
            type: 'doc',
            content: [
                inCell
                    ? {
                          type: 'table',
                          content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph] }] }],
                      }
                    : paragraph,
            ],
        },
    });
    editor.commands.setNodeSelection(inCell ? 5 : 2);
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
    const img = editor.view.dom.querySelector('img');
    if (img) {
        Object.defineProperty(img, 'naturalWidth', { value: 400 });
        Object.defineProperty(img, 'naturalHeight', { value: 200 });
    }
    // The load fires no transaction, so the panel reads the picture's ratio at the next one.
    await act(async () => editor.view.dispatch(editor.state.tr));
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
    const editor = await mount({ layout: 'wrap-left' }, { band: true });
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
const heightField = () => {
    const input = document.querySelectorAll<HTMLInputElement>('input[type="number"]')[1];
    if (!input) throw new Error('no Height field');
    return input;
};
const sizeAt2 = (editor: InstanceType<typeof Editor>) => {
    const attrs = editor.state.doc.nodeAt(2)?.attrs;
    return { width: attrs?.['width'], height: attrs?.['height'] };
};
const aspectBox = () => {
    const box = document.querySelector<HTMLElement>('[role="checkbox"]');
    if (!box) throw new Error('no Keep aspect ratio box');
    return box;
};

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

// The field's step of 0.01 gives its decimals, so a size reads alike in every field: 10 cm shows 10.00.
test('the Width field shows the figure width in cm, to two decimals, and a draft as typed', async () => {
    await mount({ width: 378 });
    expect(widthField().value).toBe('10.00');
    await type(widthField(), '8.5');
    expect(widthField().value).toBe('8.5');
    expect(widthField().parentElement?.textContent).toBe('cm');
});

test('Enter in the Width field writes the width in px and keeps the figure selected and the panel open', async () => {
    const editor = await mount();
    await type(widthField(), '8');
    await key(widthField(), 'Enter');

    expect(widthAt2(editor)).toBe(302);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    expect(widthField().value).toBe('7.99');
});

test('a blur writes the Width field', async () => {
    const editor = await mount();
    await type(widthField(), '8');
    await act(async () => widthField().blur());

    expect(widthAt2(editor)).toBe(302);
});

// 300 px shows as 7.94 cm, which is 300.1 px.
test.each(['Enter', 'blur'])('an untouched Width field keeps the stored width on %s', async (end) => {
    const editor = await mount({ width: 300 });
    await act(async () => widthField().focus());
    if (end === 'Enter') await key(widthField(), 'Enter');
    await act(async () => widthField().blur());

    expect(widthAt2(editor)).toBe(300);
    expect(widthField().value).toBe('7.94');
});

test.each([
    ['block', '30', 600, '15.88'],
    ['wrap-left', '30', 300, '7.94'],
    ['block', '1', 100, '2.65'],
    ['block', '6.63', 251, '6.64'],
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
    expect(widthField().value).toBe('5.29');
});

test('an emptied Width field writes nothing', async () => {
    const editor = await mount();
    await type(widthField(), '');
    await key(widthField(), 'Enter');
    await act(async () => widthField().blur());

    expect(widthAt2(editor)).toBe(200);
    expect(widthField().value).toBe('5.29');
});

test('a resize by Shift and an arrow key or by a grip shows in the Width field', async () => {
    const editor = await mount();
    await act(async () => {
        editor.view.dom.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
        );
    });
    expect(widthAt2(editor)).toBe(210);
    expect(widthField().value).toBe('5.56');

    // A grip's drag ends in this write.
    await act(async () => {
        editor.commands.command(({ tr }) => {
            setFigureAttributes(tr, 2, { width: 250 });
            return true;
        });
    });
    expect(widthField().value).toBe('6.61');
});

// With no height stored, the picture draws at its own ratio: 200 px wide is 100 px tall.
test('W and H show the drawn size in cm, and Keep aspect ratio starts checked', async () => {
    await mount();
    expect([widthField().value, heightField().value]).toEqual(['5.29', '2.65']);
    expect(heightField().parentElement?.textContent).toBe('cm');
    expect(aspectBox().getAttribute('aria-checked')).toBe('true');
});

test('a stored height shows in H', async () => {
    await mount({ height: 300 });
    expect(heightField().value).toBe('7.94');
});

// A picture at its own ratio stores no height, so it stays at that ratio wherever it is drawn.
test.each([
    ['W', '8', { width: 302, height: null }],
    ['H', '4', { width: 302, height: null }],
])('a locked %s edit of a picture at its own ratio writes the width alone', async (side, value, size) => {
    const editor = await mount();
    const input = side === 'W' ? widthField() : heightField();
    await type(input, value);
    await key(input, 'Enter');
    expect(sizeAt2(editor)).toEqual(size);
    expect(heightField().value).toBe('4.00');
});

test('a locked W edit of a stretched picture scales its height', async () => {
    const editor = await mount({ height: 50 });
    await type(widthField(), '8');
    await key(widthField(), 'Enter');
    expect(sizeAt2(editor)).toEqual({ width: 302, height: 76 });
});

test.each([
    ['W', '8', { width: 302, height: 100 }],
    ['H', '4', { width: 200, height: 151 }],
])('an unlocked %s edit stretches the picture, writing both sides', async (side, value, size) => {
    const editor = await mount();
    await click(aspectBox());
    expect(aspectBox().getAttribute('aria-checked')).toBe('false');
    const input = side === 'W' ? widthField() : heightField();
    await type(input, value);
    await key(input, 'Enter');
    expect(sizeAt2(editor)).toEqual(size);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
});

// Coupled first, then fitted: 30 cm is 1134 x 284 px, which the 600 px column shrinks in shape.
test('a W past the column scales both sides to it', async () => {
    const editor = await mount({ height: 50 });
    await type(widthField(), '30');
    await key(widthField(), 'Enter');
    expect(sizeAt2(editor)).toEqual({ width: 600, height: 150 });
});

test('an H below the floor is raised to it', async () => {
    const editor = await mount();
    await click(aspectBox());
    await type(heightField(), '1');
    await key(heightField(), 'Enter');
    expect(sizeAt2(editor)).toEqual({ width: 200, height: 100 });
});

test.each(['Enter', 'blur'])('an untouched H field writes nothing on %s', async (end) => {
    const editor = await mount();
    await act(async () => heightField().focus());
    if (end === 'Enter') await key(heightField(), 'Enter');
    await act(async () => heightField().blur());
    expect(sizeAt2(editor)).toEqual({ width: 200, height: null });
});

test('Escape drops a typed height', async () => {
    const editor = await mount();
    await type(heightField(), '8');
    await key(heightField(), 'Escape');
    await act(async () => heightField().blur());
    expect(sizeAt2(editor)).toEqual({ width: 200, height: null });
    expect(heightField().value).toBe('2.65');
});

// The lock lasts while its figure stays selected: nodes have no id to remember it by.
test('an unchecked lock stays while the figure is selected, and resets once it is left', async () => {
    const editor = await mount();
    await click(aspectBox());
    await act(async () => {
        editor.view.dispatch(editor.state.tr.insertText('x', 1));
    });
    expect(aspectBox().getAttribute('aria-checked')).toBe('false');

    await act(async () => void editor.commands.setTextSelection(1));
    await act(async () => void editor.commands.setNodeSelection(3));
    expect(aspectBox().getAttribute('aria-checked')).toBe('true');
});

const click = (target: HTMLElement) =>
    act(async () => {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

const toggle = (label: string) => {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!button) throw new Error(`no ${label} toggle`);
    return button;
};

test.each([
    ['In front of text', 'front'],
    ['Behind text', 'behind'],
])('%s keeps the image where it is drawn, leads its paragraph with it and keeps it selected', async (label, layout) => {
    const editor = await mount();
    const paragraph = editor.view.nodeDOM(0);
    const content = editor.view.dom.querySelector('.figure')?.firstElementChild;
    if (!(paragraph instanceof Element) || !content) throw new Error('not drawn');
    paragraph.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 100, width: 600, height: 120 });
    content.getBoundingClientRect = () => DOMRect.fromRect({ x: 300, y: 115, width: 200, height: 100 });

    await act(async () => toggle(label).click());

    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ layout, offsetX: 200, offsetY: 15 });
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 1 });
    expect(toggle(label).getAttribute('aria-pressed')).toBe('true');
});

test('an image wider than the paper is capped at it as it goes in front of the text', async () => {
    const editor = await mount({ width: 900 });
    await act(async () => toggle('In front of text').click());
    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ layout: 'front', width: 800 });
});

test('a stretched image capped at the paper keeps its shape', async () => {
    const editor = await mount({ width: 900, height: 450 });
    await act(async () => toggle('In front of text').click());
    expect(editor.state.doc.nodeAt(1)?.attrs).toMatchObject({ layout: 'front', width: 800, height: 400 });
});

test('an image in front of or behind the text has no caption row', async () => {
    await mount({ layout: 'behind' });
    expect(document.querySelector('input[placeholder="Caption"]')).toBeNull();
});

test.each([
    ['a note', { note: true }],
    ['a table cell', { inCell: true }],
])("%s's panel offers no place in front of or behind the text", async (_where, options) => {
    await mount({}, options);
    const labels = [...document.querySelectorAll('button[aria-pressed]')].map((t) => t.getAttribute('aria-label'));
    expect(labels).toEqual(['In line', 'Wrap left', 'Wrap right', 'Align left', 'Align center', 'Align right']);
});
