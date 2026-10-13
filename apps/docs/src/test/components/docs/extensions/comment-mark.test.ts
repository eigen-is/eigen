import { expect, test } from 'bun:test';
import { Editor, getSchema } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { readLatex, writeMathml } from '@workspace/math';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { AtomMarks } from '../../../../components/docs/extensions/atom-marks';
import {
    addCommentAnchor,
    canAnchorComment,
    commentAnchorText,
    nodeCommentCardId,
    removeCommentAnchors,
    selectCommentAnchor,
} from '../../../../components/docs/extensions/comment-mark';

// An equation reads its stored MathML with DOMParser.
installHappyDom();

const schema = getSchema(getDocExtensions());
const x = [{ kind: 'identifier' as const, text: 'x' }];
const equation = (latex?: string, commentCardId: string | null = null) => ({
    type: 'equation',
    attrs: { mathml: writeMathml(x, latex), commentCardId },
});
const text = (t: string, ...marks: object[]) => ({ type: 'text', text: t, ...(marks.length > 0 ? { marks } : {}) });
const docOf = (...content: object[]) => ({ type: 'doc', content: [{ type: 'paragraph', content }] });

// Each inline node as its name or text, its card by attribute and its card by mark.
function anchors(doc: Node): [string, string | null, string | null][] {
    const result: [string, string | null, string | null][] = [];
    doc.descendants((node) => {
        if (!node.isInline) return;
        const mark = node.marks.find((m) => m.type.name === 'comment');
        result.push([node.text ?? node.type.name, node.attrs.commentCardId ?? null, mark?.attrs.cardId ?? null]);
    });
    return result;
}

test('a comment on an equation anchors by its attribute and quotes its linear form, or "Equation" when empty', () => {
    const typed = '\\frac{x}{2}';
    const doc = schema.nodeFromJSON(
        docOf({ type: 'equation', attrs: { mathml: writeMathml(readLatex(typed), typed), commentCardId: 'card-1' } }),
    );
    const node = doc.firstChild?.firstChild;
    expect(node && nodeCommentCardId(node)).toBe('card-1');
    expect(commentAnchorText(doc, 0, doc.content.size)).toBe('x/2');
    const bare = schema.nodeFromJSON(docOf({ type: 'equation', attrs: { mathml: '' } }));
    expect(commentAnchorText(bare, 0, bare.content.size)).toBe('Equation');
});

test('a comment over a page number quotes its #', () => {
    const doc = schema.nodeFromJSON(docOf(text('Page '), { type: 'pageNumber', attrs: { kind: 'page' } }));
    expect(commentAnchorText(doc, 0, doc.content.size)).toBe('Page #');
});

test('a new card on an equation selected alone anchors as its attribute', () => {
    const editor = new Editor({
        extensions: [...getDocExtensions(), AtomMarks],
        content: docOf(text('a '), equation('x')),
    });
    addCommentAnchor(editor, { from: 3, to: 4 }, 'card-1');
    expect(anchors(editor.state.doc)).toEqual([
        ['a ', null, null],
        ['equation', 'card-1', null],
    ]);
    editor.destroy();
});

// A mark on the equation would last only until reload.
test('a new card on text and an equation marks the text alone', () => {
    const editor = new Editor({
        extensions: [...getDocExtensions(), AtomMarks],
        content: docOf(text('a '), equation('x')),
    });
    addCommentAnchor(editor, { from: 1, to: 4 }, 'card-1');
    expect(anchors(editor.state.doc)).toEqual([
        ['a ', null, 'card-1'],
        ['equation', null, null],
    ]);
    editor.destroy();
});

test("a deleted card leaves no anchor: its text's mark, its figure's and its equation's attribute", () => {
    const editor = new Editor({
        extensions: getDocExtensions(),
        content: docOf(
            text('a', { type: 'comment', attrs: { cardId: 'card-1' } }),
            { type: 'figure', attrs: { mediaName: 'a.png', commentCardId: 'card-1' } },
            equation('x', 'card-1'),
            equation('y', 'card-2'),
        ),
    });
    removeCommentAnchors(editor, 'card-1');
    expect(anchors(editor.state.doc)).toEqual([
        ['a', null, null],
        ['figure', null, null],
        ['equation', null, null],
        ['equation', 'card-2', null],
    ]);
    editor.destroy();
});

test("scrolling to an equation's card selects the equation", () => {
    const editor = new Editor({
        extensions: getDocExtensions(),
        content: docOf(text('a '), equation('x', 'card-1')),
    });
    selectCommentAnchor(editor, 'card-1');
    const { selection } = editor.state;
    expect(selection instanceof NodeSelection && selection.node.type.name).toBe('equation');
    editor.destroy();
});

// A page number holds no card attribute, so a card never anchors on one by attribute.
test('a page number anchors no card by attribute, and a card on one selected alone sets none', () => {
    const editor = new Editor({
        extensions: [...getDocExtensions(), AtomMarks],
        content: docOf(text('a '), { type: 'pageNumber', attrs: { kind: 'page' } }),
    });
    const node = editor.state.doc.nodeAt(3);
    expect(node && nodeCommentCardId(node)).toBeNull();
    expect(() => addCommentAnchor(editor, { from: 3, to: 4 }, 'card-1')).not.toThrow();
    expect(anchors(editor.state.doc)).toEqual([
        ['a ', null, null],
        ['pageNumber', null, null],
    ]);
    editor.destroy();
});

test('a comment anchors on text or a node holding a card attribute, never on a page number alone', () => {
    const editor = new Editor({
        extensions: [...getDocExtensions(), AtomMarks],
        content: docOf(text('a '), equation('x'), { type: 'pageNumber', attrs: { kind: 'page' } }),
    });
    const anchorable = (selection: (doc: Node) => NodeSelection | TextSelection) => {
        editor.view.dispatch(editor.state.tr.setSelection(selection(editor.state.doc)));
        return canAnchorComment(editor.state);
    };
    expect(anchorable((doc) => TextSelection.create(doc, 1, 3))).toBe(true);
    expect(anchorable((doc) => TextSelection.create(doc, 2, 5))).toBe(true);
    expect(anchorable((doc) => NodeSelection.create(doc, 3))).toBe(true);
    expect(anchorable((doc) => NodeSelection.create(doc, 4))).toBe(false);
    expect(anchorable((doc) => TextSelection.create(doc, 4, 5))).toBe(false);
    expect(anchorable((doc) => TextSelection.create(doc, 2))).toBe(false);
    editor.destroy();
});
