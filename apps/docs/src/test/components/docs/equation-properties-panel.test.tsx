// The Equation panel edits a draft of the selected equation's LaTeX: the preview draws the draft, Enter or a blur
// writes it when it parses, Enter returning to the document after the equation, and Escape drops it. A draft that
// doesn't parse is never written and shows where the reader stopped. `\name` and a space give the command's braces,
// and a symbol menu inserts its command at the field's caret. A draft that starts with <math is MathML, read as a stored
// one is.
import { afterEach, expect, test } from 'bun:test';
import { readEquation } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { NodeSelection } = await import('@tiptap/pm/state');
const { MATH_LIMITS, MATHML_NAMESPACE, readLatex, writeMathml } = await import('@workspace/math');
const { Equation } = await import('../../../components/docs/extensions/equation');
const { EquationPropertiesPanel } = await import('../../../components/docs/equation-properties-panel');

let unmount = async () => {};
afterEach(() => unmount());

const typed = (latex: string) => writeMathml(readLatex(latex), latex);

// "a" at 1, the equation at 2, then the `next` equation if any, then "b", the first equation selected.
async function mount(attrs: object = { mathml: typed('x^2') }, next?: object) {
    const editor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        extensions: [...getDocExtensions({ exclude: ['equation'] }), Equation],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'a' },
                        { type: 'equation', attrs },
                        ...(next ? [{ type: 'equation', attrs: next }] : []),
                        { type: 'text', text: 'b' },
                    ],
                },
            ],
        },
    });
    editor.commands.setNodeSelection(2);
    const fieldRef = createRef<HTMLTextAreaElement>();
    const rendered = await renderInDocument(createElement(EquationPropertiesPanel, { editor, fieldRef }));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    return editor;
}

const field = () => {
    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="LaTeX"]');
    if (!input) throw new Error('no LaTeX field');
    return input;
};
const stored = (editor: InstanceType<typeof Editor>) => editor.state.doc.nodeAt(2)?.attrs;
// The preview's <math>, outside the menus.
const preview = () => document.querySelector('[data-slot="scroll-area-viewport"] math');

// React tracks a field's value on the instance; the prototype setter leaves its tracker stale, as a keystroke does.
const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

const type = (value: string) =>
    act(async () => {
        const input = field();
        input.focus();
        nativeValueSetter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
// A keystroke that leaves the caret at `caret`.
const typeAt = (value: string, caret: number) =>
    act(async () => {
        const input = field();
        input.focus();
        nativeValueSetter?.call(input, value);
        input.setSelectionRange(caret, caret);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
// A peer's transaction.
const remote = (editor: InstanceType<typeof Editor>, edit: (tr: InstanceType<typeof Editor>['state']['tr']) => void) =>
    act(async () => {
        const { tr } = editor.state;
        edit(tr);
        editor.view.dispatch(tr);
    });
const key = (name: string, init: KeyboardEventInit = {}) =>
    act(async () => {
        field().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
    });

test('the field shows the LaTeX, and the preview draws its MathML', async () => {
    await mount();
    expect(field().value).toBe('x^2');
    expect(preview()?.namespaceURI).toBe(MATHML_NAMESPACE);
    expect(preview()?.querySelector('msup')?.textContent).toBe('x2');
});

test('an equation stored without LaTeX, as from Word, shows the LaTeX of its tree', async () => {
    await mount({ mathml: writeMathml(readLatex('\\frac{a}{b}')) });
    expect(field().value).toBe('\\frac{a}{b}');
});

test('an empty equation previews as an empty box', async () => {
    await mount({ mathml: '' });
    expect(field().value).toBe('');
    expect(preview()).toBeNull();
    expect(document.querySelector('[aria-label="Empty equation"]')).not.toBeNull();
});

test('a draft previews without writing the equation', async () => {
    const editor = await mount();
    await type('\\sqrt{y}');
    expect(preview()?.querySelector('msqrt')?.textContent).toBe('y');
    expect(stored(editor)?.['mathml']).toBe(typed('x^2'));
});

test('the preview draws an empty argument as a dotted box', async () => {
    await mount();
    await type('\\frac{}{}');
    expect([...(preview()?.querySelectorAll('mfrac > mtext.equation-slot') ?? [])]).toHaveLength(2);
});

test('Enter writes the draft with its LaTeX and puts the caret after the equation', async () => {
    const editor = await mount();
    const draft = 'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}';
    await type(draft);
    await key('Enter', { metaKey: true });

    expect(stored(editor)?.['mathml']).toBe(typed(draft));
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 3, head: 3 });
    expect(editor.isFocused).toBe(true);
});

test('a blur writes the draft and keeps the equation selected', async () => {
    const editor = await mount();
    await type('y');
    await act(async () => field().blur());

    expect(stored(editor)?.['mathml']).toBe(typed('y'));
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
});

// A Word equation's LaTeX is the tree's, so a visit would otherwise give it an annotation it never had.
// The comments panel taking the slot, or a phone's width, unmounts the field with no blur.
test('an unmount writes the draft, as a blur does', async () => {
    const editor = await mount();
    await type('y');
    await unmount();
    expect(stored(editor)?.['mathml']).toBe(typed('y'));
});

test('focusing and leaving the field writes nothing', async () => {
    const mathml = writeMathml(readLatex('\\frac{a}{b}'));
    const editor = await mount({ mathml });
    await act(async () => field().focus());
    await act(async () => field().blur());
    expect(stored(editor)?.['mathml']).toBe(mathml);
});

test('Escape drops the draft', async () => {
    const editor = await mount();
    await type('y');
    await key('Escape');
    await act(async () => field().blur());

    expect(stored(editor)?.['mathml']).toBe(typed('x^2'));
    expect(field().value).toBe('x^2');
});

test('a draft that does not parse is never written, and shows its error where the reader stopped', async () => {
    const editor = await mount();
    await type('\\frac{a');
    await key('Enter', { metaKey: true });
    await act(async () => field().blur());

    expect(stored(editor)?.['mathml']).toBe(typed('x^2'));
    expect(field().getAttribute('aria-invalid')).toBe('true');
    // The field's description, which no keystroke announces.
    const error = document.getElementById(field().getAttribute('aria-describedby') ?? '');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(error?.textContent).toContain('A { without its }');
    // The reader stops at the brace, offset 5.
    expect(error?.querySelector('.decoration-wavy')?.textContent).toBe('{');
    // The draft stays for the user to finish, and the preview shows the equation as it stands.
    expect(field().value).toBe('\\frac{a');
    expect(preview()?.querySelector('msup')).not.toBeNull();
});

test('MathML in the field previews and writes its tree, the LaTeX of its tree the annotation', async () => {
    const editor = await mount();
    await type(
        `  <math xmlns="${MATHML_NAMESPACE}"><mfrac><mi>a</mi><msup><mi>b</mi><mn>2</mn></msup></mfrac></math>\n`,
    );
    expect(field().getAttribute('aria-invalid')).toBe('false');
    expect(preview()?.querySelector('mfrac')).not.toBeNull();
    await act(async () => field().blur());

    expect(stored(editor)?.['mathml']).toBe(typed('\\frac{a}{b^{2}}'));
    expect(field().value).toBe('\\frac{a}{b^{2}}');
});

test("MathML with LaTeX of its own writes that LaTeX, and with LaTeX the reader refuses its tree's", async () => {
    const editor = await mount();
    await type(writeMathml(readLatex('\\frac12'), '\\frac12'));
    await act(async () => field().blur());
    expect(stored(editor)?.['mathml']).toBe(typed('\\frac12'));

    await type(writeMathml(readLatex('y'), '\\nosuch'));
    await act(async () => field().blur());
    expect(stored(editor)?.['mathml']).toBe(typed('y'));
});

test.each([
    ['unclosed', '<math><mi>x</mi>'],
    ['past the length bound', `<math><mi>x</mi>${' '.repeat(MATH_LIMITS.mathmlLength)}</math>`],
])('MathML %s is never written and shows an error', async (_, draft) => {
    const editor = await mount();
    await type(draft);
    await key('Enter', { metaKey: true });
    await act(async () => field().blur());

    expect(stored(editor)?.['mathml']).toBe(typed('x^2'));
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(field().getAttribute('aria-describedby') ?? '')?.textContent).toContain('MathML');
    expect(field().value).toBe(draft);
});

test.each([
    ['\\frac', '\\frac{}{}'],
    ['\\sqrt', '\\sqrt{}'],
    ['x+\\overline', 'x+\\overline{}'],
])('%s and a space give %s, the caret in the first braces', async (before, after) => {
    await mount({ mathml: '' });
    await type(before);
    await type(`${before} `);
    expect(field().value).toBe(after);
    expect(field().selectionStart).toBe(before.length + 1);
});

test.each([
    ['\\frac{a}{b}', '\\frac {a}{b}'],
    ['\\sqrt[3]{x}', '\\sqrt [3]{x}'],
])('a space after a command whose arguments follow stays a space: %s', async (before, after) => {
    await mount({ mathml: '' });
    await type(before);
    await typeAt(after, after.indexOf(' ') + 1);
    expect(field().value).toBe(after);
});

test('a space after a command with no arguments stays a space', async () => {
    await mount({ mathml: '' });
    await type('\\alpha');
    await type('\\alpha ');
    expect(field().value).toBe('\\alpha ');
});

test('a space pasted with more text expands nothing', async () => {
    await mount({ mathml: '' });
    await type('\\frac ');
    expect(field().value).toBe('\\frac ');
});

test('the Style options write display and keep the equation selected', async () => {
    const editor = await mount();
    const inline = document.querySelector<HTMLButtonElement>('button[aria-label="In line with text"]');
    const ownLine = document.querySelector<HTMLButtonElement>('button[aria-label="On its own line"]');
    expect(inline?.getAttribute('aria-pressed')).toBe('true');
    expect(ownLine?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => ownLine?.click());

    expect(stored(editor)?.['display']).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    expect(ownLine?.getAttribute('aria-pressed')).toBe('true');
    expect(inline?.getAttribute('aria-pressed')).toBe('false');
    expect(preview()?.getAttribute('display')).toBe('block');

    await act(async () => inline?.click());

    expect(stored(editor)?.['display']).toBe(false);
    expect(preview()?.getAttribute('display')).not.toBe('block');
});

const openMenu = (menu: string) =>
    act(async () => {
        document
            .querySelector(`button[aria-label="${menu}"]`)
            ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
// Radix gives the focus back in a timeout its unmount sets, which a later timeout follows.
async function clickItem(item: string) {
    await act(async () => document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="${item}"]`)?.click());
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

test('a symbol menu inserts its command at the caret and gives the field back its focus', async () => {
    const editor = await mount();
    await type('ab');
    await act(async () => field().setSelectionRange(1, 1));
    await openMenu('Greek letters');
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(40);

    await clickItem('α');

    expect(field().value).toBe('a\\alpha b');
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe('a\\alpha '.length);
    // The draft is no peer's until committed.
    expect(stored(editor)?.['mathml']).toBe(typed('x^2'));
    await key('Enter', { metaKey: true });
    expect(stored(editor)?.['mathml']).toBe(typed('a\\alpha b'));
});

// Its first slot past a base, which the text before the caret already holds.
test.each([
    ['Fraction', '\\frac{', '}{}'],
    ['Root', '\\sqrt[', ']{}'],
    ['Subscript and superscript', 'x_{', '}^{}'],
    ['Parentheses', 'x\\left( ', '\\right)'],
])('a template, %s, puts the caret in its first slot', async (item, before, after) => {
    await mount({ mathml: '' });
    await type(before.startsWith('x') ? 'x' : '');
    await openMenu('Math operations');
    await clickItem(item);
    expect(field().value).toBe(before + after);
    expect(field().selectionStart).toBe(before.length);
});

// Shift and an arrow over it, or a drag across it, select it as text, and the panel reads it the same.
test('an equation selected as text takes the draft and the Style options', async () => {
    const editor = await mount();
    await act(async () => editor.commands.setTextSelection({ from: 2, to: 3 }));
    await type('y');
    await key('Enter', { metaKey: true });
    expect(stored(editor)?.['mathml']).toBe(typed('y'));
    expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 3, head: 3 });

    await act(async () => editor.commands.setTextSelection({ from: 2, to: 3 }));
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="On its own line"]')?.click());
    expect(stored(editor)?.['display']).toBe(true);
});

// A drag across two equations: the panel shows the last, and its LaTeX is that one's alone, while Style, as a
// figure's layout, is every one's.
test('a selection of two equations writes the draft to the one shown and Style to both', async () => {
    const editor = await mount({ mathml: typed('x^2') }, { mathml: typed('z') });
    await act(async () => editor.commands.setTextSelection({ from: 2, to: 4 }));
    expect(field().value).toBe('z');
    await type('w');
    await act(async () => field().blur());
    expect(stored(editor)?.['mathml']).toBe(typed('x^2'));
    expect(editor.state.doc.nodeAt(3)?.attrs['mathml']).toBe(typed('w'));

    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="On its own line"]')?.click());
    expect(stored(editor)?.['display']).toBe(true);
    expect(editor.state.doc.nodeAt(3)?.attrs['display']).toBe(true);
});

test('a draft whose write finds no equation stays', async () => {
    const editor = await mount();
    await type('y');
    await act(async () => editor.commands.setTextSelection(1));
    await key('Enter', { metaKey: true });
    expect(field().value).toBe('y');
    expect(stored(editor)?.['mathml']).toBe(typed('x^2'));
});

// A visit is no draft: a peer's write shows, and the blur after it leaves theirs.
test('a peer writing the equation of a focused, untouched field keeps theirs', async () => {
    const editor = await mount();
    await act(async () => field().focus());
    await remote(editor, (tr) => tr.setNodeAttribute(2, 'mathml', typed('z')));
    expect(field().value).toBe('z');
    await act(async () => field().blur());
    expect(stored(editor)?.['mathml']).toBe(typed('z'));
});

test("a draft typed back to where it started writes nothing over a peer's write", async () => {
    const editor = await mount();
    await type('y');
    await type('x^2');
    await remote(editor, (tr) => tr.setNodeAttribute(2, 'mathml', typed('z')));
    await act(async () => field().blur());
    expect(stored(editor)?.['mathml']).toBe(typed('z'));
    expect(field().value).toBe('z');
});

// The last writer wins.
test("a peer's write to the equation leaves the draft, and Enter writes it", async () => {
    const editor = await mount();
    await type('y');
    await remote(editor, (tr) => tr.setNodeAttribute(2, 'mathml', typed('z')));
    expect(field().value).toBe('y');
    await key('Enter', { metaKey: true });
    expect(stored(editor)?.['mathml']).toBe(typed('y'));
});

// The Yjs binding selects whatever node then sits where the selected one stood.
test('a peer deleting the equation ends its draft, which never lands on the next one', async () => {
    const editor = await mount({ mathml: typed('x^2') }, { mathml: typed('z') });
    await type('y');
    await remote(editor, (tr) => tr.delete(2, 3).setSelection(NodeSelection.create(tr.doc, 2)));
    expect(field().value).toBe('z');
    await key('Enter', { metaKey: true });
    expect(stored(editor)?.['mathml']).toBe(typed('z'));
});

// A collaborator typing above the equation moves it, and the selection with it.
test('an edit above the equation leaves a half-typed draft and its focus alone', async () => {
    const editor = await mount();
    await type('\\frac{a');
    await act(async () => {
        editor.view.dispatch(editor.state.tr.insertText('x', 1));
    });

    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 3 });
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe('\\frac{a');
});

test('a draft that does not parse is dropped once another equation is selected', async () => {
    const editor = await mount();
    await type('\\frac{a');
    await act(async () => field().blur());
    await act(async () => {
        editor
            .chain()
            .insertContentAt(4, { type: 'equation', attrs: { mathml: typed('z') } })
            .setNodeSelection(4)
            .run();
    });
    expect(field().value).toBe('z');
});

test('Enter in the field starts a line, and a multi-line draft commits with its newlines and the same equation', async () => {
    const editor = await mount();
    const multi = '\\frac{1}{2}\n  + x^2';
    await type(multi);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => field().dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(false);
    expect(stored(editor)?.['mathml']).toBe(typed('x^2'));

    await key('Enter', { metaKey: true });
    expect(stored(editor)?.['mathml']).toBe(typed(multi));
    expect(readLatex(multi)).toEqual(readLatex('\\frac{1}{2} + x^2'));
    expect(readEquation(stored(editor) ?? {}).latex).toBe(multi);
});
