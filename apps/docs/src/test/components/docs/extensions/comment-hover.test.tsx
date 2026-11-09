// What the body reports to a comment's hover card as the pointer moves, through the real marks and node views: a mark
// on text or a figure's or an equation's corner mark names its card, at the line under the pointer, and anything else
// reads as left. The resolved highlight is gone, while a corner mark stays. The whole figure is no target, and the
// target's attribute stays out of what the document writes.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CommentHover } from '@workspace/lib/types/comments';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { readLatex, writeMathml } = await import('@workspace/math');
const { CommentMark, reportCommentHover, updateCommentDecorations } = await import(
    '../../../../components/docs/extensions/comment-mark'
);
const { Equation } = await import('../../../../components/docs/extensions/equation');
const { Figure } = await import('../../../../components/docs/extensions/figure');

const show = mock((_cardId: string, _rect: DOMRect) => {});
const hide = mock(() => {});
const hover: CommentHover = {
    target: null,
    show,
    hide,
    enterCard: () => {},
    leaveCard: () => {},
    dismiss: () => {},
};

let unmount = async () => {};
beforeEach(() => {
    show.mockClear();
    hide.mockClear();
});
afterEach(() => unmount());

const CONTENT = [
    {
        type: 'paragraph',
        content: [
            { type: 'text', text: 'noted', marks: [{ type: 'comment', attrs: { cardId: 'on-text' } }] },
            { type: 'text', text: ' plain' },
            { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 200, commentCardId: 'on-figure' } },
            { type: 'equation', attrs: { mathml: writeMathml(readLatex('x')), commentCardId: 'on-equation' } },
        ],
    },
];

async function mount() {
    const editor = new Editor({
        extensions: [
            ...getDocExtensions({ exclude: ['figure', 'equation', 'comment'] }),
            CommentMark,
            Figure,
            Equation,
        ],
        content: { type: 'doc', content: CONTENT },
    });
    const rendered = await renderInDocument(
        createElement(
            'div',
            { onMouseOver: (event: React.MouseEvent) => reportCommentHover(editor, hover, event) },
            createElement(EditorContent, { editor }),
        ),
    );
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
    await act(async () => {});
    const element = (selector: string) => {
        const found = editor.view.dom.querySelector(selector);
        if (!found) throw new Error(`no ${selector}`);
        return found;
    };
    return { editor, element };
}

const moveOver = (target: Element, init: MouseEventInit = {}) =>
    act(async () => target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, ...init })));

const FIGURE_MARK = '.figure button[aria-label="Open comment"]';
const EQUATION_MARK = '.equation button[aria-label="Open comment"]';

test('the live mark on text draws its card in the attribute, and a hover over it names that card', async () => {
    const { element } = await mount();
    const span = element('.comment-highlight');
    expect(span.getAttribute('data-comment-id')).toBe('on-text');
    await moveOver(span);
    expect(show.mock.calls[0]?.[0]).toBe('on-text');
    expect(hide).not.toHaveBeenCalled();
});

test('a hover over plain text reads as left', async () => {
    const { element } = await mount();
    await moveOver(element('p'));
    expect(show).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalled();
});

test('a resolved highlight is gone, so a hover over its text reads as left', async () => {
    const { editor, element } = await mount();
    await act(async () => updateCommentDecorations(editor, new Set(['on-text']), new Map()));
    await moveOver(element('.comment-highlight'));
    expect(show).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalled();
});

test.each([
    ['a figure', FIGURE_MARK, 'on-figure'],
    ['an equation', EQUATION_MARK, 'on-equation'],
])('the corner mark of %s names its card through its node view, and has no native tooltip', async (_, mark, id) => {
    const { element } = await mount();
    const button = element(mark);
    expect(button.getAttribute('data-comment-id')).toBe(id);
    expect(button.hasAttribute('title')).toBe(false);
    await moveOver(button);
    expect(show.mock.calls[0]?.[0]).toBe(id);
});

test.each([
    ['a figure', FIGURE_MARK, 'on-figure'],
    ['an equation', EQUATION_MARK, 'on-equation'],
])('the corner mark of %s still names its card once it is resolved, as it still draws', async (_, mark, id) => {
    const { editor, element } = await mount();
    await act(async () => updateCommentDecorations(editor, new Set([id]), new Map()));
    await moveOver(element(mark));
    expect(show.mock.calls[0]?.[0]).toBe(id);
});

test.each([
    ['a figure', '.figure'],
    ['an equation', '.equation'],
])('the rest of %s holds no target, so only its corner mark names the card', async (_, view) => {
    const { element } = await mount();
    await moveOver(element(view));
    expect(show).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalled();
});

test('a move with a button pressed, as a drag or a selection, reads as left', async () => {
    const { element } = await mount();
    await moveOver(element('.comment-highlight'), { buttons: 1 });
    expect(show).not.toHaveBeenCalled();
    expect(hide).toHaveBeenCalled();
});

test('a span wrapped onto several lines reports the line under the pointer', async () => {
    const { element } = await mount();
    const span = element('.comment-highlight');
    const first = DOMRect.fromRect({ x: 100, y: 10, width: 300, height: 20 });
    const second = DOMRect.fromRect({ x: 0, y: 30, width: 150, height: 20 });
    Object.defineProperty(span, 'getClientRects', { value: () => [first, second] });
    await moveOver(span, { clientX: 50, clientY: 40 });
    expect(show.mock.calls[0]?.[1]).toBe(second);
    show.mockClear();
    await moveOver(span, { clientX: 200, clientY: 20 });
    expect(show.mock.calls[0]?.[1]).toBe(first);
});

test('the corner mark stays out of what the document writes and copies', async () => {
    const { editor, element } = await mount();
    element(FIGURE_MARK);
    const { state, view } = editor;
    const { dom } = view.serializeForClipboard(state.doc.slice(0));
    for (const html of [editor.getHTML(), dom.innerHTML]) {
        expect(html).not.toContain('<button');
        expect(html).toContain('data-comment-id="on-figure"');
    }
});
