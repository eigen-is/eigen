// The equation's node view draws the tree readEquation reads, never the stored string; a displayed equation as a
// block, an empty one as an empty box and an empty argument as a dotted one, a selected one in the selection ring, and
// a commented one with the corner mark that opens its comment.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { MATHML_NAMESPACE, readLatex, writeMathml } = await import('@workspace/math');
const { Equation } = await import('../../../../components/docs/extensions/equation');
const { CELL_INDICATOR_SIZE } = await import('@workspace/lib/constants/comment-indicator');

let unmount = async () => {};
afterEach(() => unmount());

const typed = (latex: string) => writeMathml(readLatex(latex), latex);
const onOpenComment = mock((_cardId: string) => {});

// "a" at 1, the equation at 2.
async function mount(attrs: object) {
    const editor = new Editor({
        extensions: [...getDocExtensions({ exclude: ['equation'] }), Equation.configure({ onOpenComment })],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'a' },
                        { type: 'equation', attrs },
                    ],
                },
            ],
        },
    });
    const rendered = await renderInDocument(createElement(EditorContent, { editor }));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    await act(async () => {});
    const view = editor.view.dom.querySelector<HTMLElement>('.equation');
    if (!view) throw new Error('the equation did not render');
    return { editor, view };
}

test('draws the MathML in the MathML namespace, from the tree and not the stored string', async () => {
    const forged = `<math xmlns="${MATHML_NAMESPACE}"><mi onclick="alert(1)">x</mi><script>alert(2)</script></math>`;
    const { view } = await mount({ mathml: forged });
    const math = view.querySelector('math');
    expect(math?.namespaceURI).toBe(MATHML_NAMESPACE);
    expect(math?.outerHTML).toBe(`<math xmlns="${MATHML_NAMESPACE}"><mi>x</mi></math>`);
});

test('a displayed equation is marked for its own line and its <math> displays as a block', async () => {
    const { view } = await mount({ mathml: typed('\\sum_{i=1}^n i'), display: true });
    expect(view.hasAttribute('data-display')).toBe(true);
    expect(view.querySelector('math')?.getAttribute('display')).toBe('block');
});

test('an inline equation is not', async () => {
    const { view } = await mount({ mathml: typed('x') });
    expect(view.hasAttribute('data-display')).toBe(false);
    expect(view.querySelector('math')?.hasAttribute('display')).toBe(false);
});

test('an empty equation draws an empty box', async () => {
    const { view } = await mount({ mathml: '' });
    expect(view.querySelector('math')).toBeNull();
    expect(view.querySelector('[aria-label="Empty equation"]')).not.toBeNull();
});

test('an empty argument draws a dotted box, which the stored MathML never holds', async () => {
    const { editor, view } = await mount({ mathml: typed('\\frac{}{\\sqrt{}}+\\hat{}') });
    const slots = [...view.querySelectorAll('mtext.equation-slot')];
    expect(slots.map((slot) => slot.parentElement?.localName)).toEqual(['mfrac', 'msqrt', 'mover']);
    expect(slots.every((slot) => slot.textContent === '\u2B1A')).toBe(true);
    expect(editor.state.doc.nodeAt(2)?.attrs['mathml']).toBe(typed('\\frac{}{\\sqrt{}}+\\hat{}'));
});

test.each([
    ['a script’s base, as {}^{14}C writes', '{}^{14}C'],
    ['a large operator’s body', '\\sum_{i}'],
    ['a fence', '\\left(\\right)'],
    ['a matrix cell', '\\begin{matrix} a & \\\\ & b \\end{matrix}'],
])('%s stays empty', async (_, latex) => {
    const { view } = await mount({ mathml: typed(latex) });
    expect(view.querySelector('.equation-slot')).toBeNull();
});

test('a selected equation takes the selection ring', async () => {
    const { editor, view } = await mount({ mathml: typed('x') });
    expect(view.classList.contains('eigen-selection-ring')).toBe(false);
    await act(async () => editor.commands.setNodeSelection(2));
    expect(view.classList.contains('eigen-selection-ring')).toBe(true);
});

test('a commented equation has the corner mark beside its glyphs, which opens its comment', async () => {
    const { view } = await mount({ mathml: typed('x'), commentCardId: 'card-1' });
    expect(view.style.paddingRight).toBe(`${CELL_INDICATOR_SIZE}px`);
    const mark = view.querySelector<HTMLButtonElement>('button[aria-label="Open comment"]');
    await act(async () => mark?.click());
    expect(onOpenComment).toHaveBeenCalledWith('card-1');
});

test('an equation with no comment has no corner mark', async () => {
    const { view } = await mount({ mathml: typed('x') });
    expect(view.querySelector('button')).toBeNull();
    expect(view.style.paddingRight).toBe('');
});
