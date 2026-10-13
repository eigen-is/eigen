// The Equation panel edits a draft of the selected equation's LaTeX: the preview draws the draft, Enter or a blur
// writes it when it parses, Enter returning to the document after the equation, and Escape drops it. A draft that
// doesn't parse is never written and shows where the reader stopped. `\name` and a space give the command's braces,
// and a symbol menu inserts its command at the field's caret.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { MATHML_NAMESPACE, readLatex, writeMathml } = await import('@workspace/math');
const { Equation } = await import('../../../components/docs/extensions/equation');
const { EquationPropertiesPanel } = await import('../../../components/docs/equation-properties-panel');

let unmount = async () => {};
afterEach(() => unmount());

const typed = (latex: string) => writeMathml(readLatex(latex), latex);

// "a" at 1, the equation at 2, "b" at 3, the equation selected.
async function mount(attrs: object = { mathml: typed('x^2') }) {
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
const key = (name: string) =>
    act(async () => {
        field().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
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

test('Enter writes the draft with its LaTeX and puts the caret after the equation', async () => {
    const editor = await mount();
    const draft = 'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}';
    await type(draft);
    await key('Enter');

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
    await key('Enter');
    await act(async () => field().blur());

    expect(stored(editor)?.['mathml']).toBe(typed('x^2'));
    expect(field().getAttribute('aria-invalid')).toBe('true');
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('A { without its }');
    // The reader stops at the brace, offset 5.
    expect(alert?.querySelector('.decoration-wavy')?.textContent).toBe('{');
    // The draft stays for the user to finish, and the preview shows the equation as it stands.
    expect(field().value).toBe('\\frac{a');
    expect(preview()?.querySelector('msup')).not.toBeNull();
});

test.each([
    ['\\frac', '\\frac{}{}'],
    ['\\sqrt', '\\sqrt{}'],
    ['x+\\overline', 'x+\\overline{}'],
])('%s and a space give %s, the caret after it', async (before, after) => {
    await mount({ mathml: '' });
    await type(before);
    await type(`${before} `);
    expect(field().value).toBe(after);
    expect(field().selectionStart).toBe(after.length);
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

test('the Display toggle writes display and keeps the equation selected', async () => {
    const editor = await mount();
    const toggle = document.querySelector<HTMLButtonElement>('button[aria-label="Display on its own line"]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => toggle?.click());

    expect(stored(editor)?.['display']).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual({ type: 'node', anchor: 2 });
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(preview()?.getAttribute('display')).toBe('block');
});

test('a symbol menu inserts its command at the caret and gives the field back its focus', async () => {
    const editor = await mount();
    await type('ab');
    await act(async () => field().setSelectionRange(1, 1));
    const trigger = document.querySelector('button[aria-label="Greek letters"]');
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(40);

    const alpha = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="alpha"]');
    await act(async () => {
        alpha?.click();
        // Radix hands the focus back once the menu has closed.
        await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(field().value).toBe('a\\alpha b');
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe('a\\alpha '.length);
    // The draft is no peer's until committed.
    expect(stored(editor)?.['mathml']).toBe(typed('x^2'));
    await key('Enter');
    expect(stored(editor)?.['mathml']).toBe(typed('a\\alpha b'));
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
