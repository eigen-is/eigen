import { expect, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import { sampleChartSpec } from '@workspace/lib/charts';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { writeMathml } from '@workspace/math';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { AtomMarks } from '../../../../components/docs/extensions/atom-marks';

// An equation reads its stored MathML with DOMParser.
installHappyDom();

const mathml = writeMathml([{ kind: 'identifier', text: 'x' }], 'x');
const equation = { type: 'equation', attrs: { mathml } };
const figure = { type: 'figure', attrs: { mediaName: 'a.png' } };

function editorWith(content: object[]) {
    return new Editor({
        extensions: [...getDocExtensions(), AtomMarks],
        content: { type: 'doc', content: [{ type: 'paragraph', content }] },
    });
}

const markedNodes = (editor: Editor) => {
    const marked: string[] = [];
    editor.state.doc.descendants((node) => {
        if (node.marks.length > 0) marked.push(node.type.name);
    });
    return marked;
};

// The Yjs binding would drop a mark on an atom, so the formatting would show until a reload and never reach a peer.
test('formatting a range around an equation marks the text and leaves the equation alone', () => {
    const editor = editorWith([{ type: 'text', text: 'a ' }, equation, { type: 'text', text: ' b' }]);
    editor.chain().selectAll().setBold().setColor('#ff0000').toggleHighlight().run();
    expect(markedNodes(editor)).toEqual(['text', 'text']);
    editor.destroy();
});

test('an equation inserted with a mark, as a paste inside a bold run gives it, loses the mark', () => {
    const editor = editorWith([{ type: 'text', text: 'a', marks: [{ type: 'bold' }] }]);
    editor.commands.insertContentAt(2, { ...equation, marks: [{ type: 'bold' }] });
    expect(editor.state.doc.firstChild?.lastChild?.type.name).toBe('equation');
    expect(markedNodes(editor)).toEqual(['text']);
    editor.destroy();
});

test('bold, colour and a link over a range containing a figure mark the text and leave the figure alone', () => {
    const editor = editorWith([{ type: 'text', text: 'a ' }, figure, { type: 'text', text: ' b' }]);
    editor.chain().selectAll().setBold().setColor('#ff0000').setLink({ href: 'https://example.com' }).run();
    expect(markedNodes(editor)).toEqual(['text', 'text']);
    editor.destroy();
});

test('a figure inserted with a mark loses the mark', () => {
    const editor = editorWith([{ type: 'text', text: 'a', marks: [{ type: 'bold' }] }]);
    editor.commands.insertContentAt(2, { ...figure, marks: [{ type: 'bold' }] });
    expect(editor.state.doc.firstChild?.lastChild?.type.name).toBe('figure');
    expect(markedNodes(editor)).toEqual(['text']);
    editor.destroy();
});

// Typed as ProseMirror types a key, which gives the text the caret's marks: the marks of what landed at `pos`.
const typeAt = (editor: Editor, pos: number, text: string) => {
    editor.commands.setTextSelection(pos);
    editor.view.dispatch(editor.state.tr.insertText(text));
    return editor.state.doc.nodeAt(pos)?.marks.map((mark) => mark.type.name);
};

// ProseMirror reads the caret's marks off the node before it, which an atom never has; Google Docs keeps the run's.
test.each([
    ['equation', equation],
    ['figure', figure],
])('text typed right after an inline %s keeps the formatting of the run around it', (_name, atom) => {
    const bold = [{ type: 'bold' }, { type: 'italic' }];
    const editor = editorWith([
        { type: 'text', text: 'a', marks: bold },
        atom,
        { type: 'text', text: 'b', marks: bold },
    ]);
    expect(typeAt(editor, 3, 'c')).toEqual(['bold', 'italic']);
    editor.destroy();
});

// With no text before it, the run is the text after.
test.each([
    ['before', 1],
    ['after', 2],
])('text typed %s an equation that starts its paragraph takes the marks of the text after it', (_side, pos) => {
    const editor = editorWith([equation, { type: 'text', text: 'b', marks: [{ type: 'bold' }] }]);
    expect(typeAt(editor, pos, 'c')).toEqual(['bold']);
    editor.destroy();
});

// A mark that ends with its text (`inclusive: false`) ends at the atom as it would at the text's end.
test.each([
    ['an inclusive link runs on', true],
    ['a link that ends with its text stays behind', false],
])('after an equation, %s as after plain text', (_case, inclusive) => {
    const linked = {
        type: 'text',
        text: 'a',
        marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://e.com' } }],
    };
    const editorOf = (content: object[]) =>
        new Editor({
            extensions: [...getDocExtensions(), AtomMarks],
            content: { type: 'doc', content: [{ type: 'paragraph', content }] },
        });
    const withEquation = editorOf([linked, equation]);
    const plain = editorOf([linked]);
    for (const editor of [withEquation, plain]) editor.schema.marks['link'].spec.inclusive = inclusive;
    const marks = typeAt(withEquation, 3, 'c');
    expect(marks).toEqual(typeAt(plain, 2, 'c'));
    expect(marks).toHaveLength(inclusive ? 2 : 1);
    withEquation.destroy();
    plain.destroy();
});

test('bold turned off right after the equation stays off', () => {
    const editor = editorWith([{ type: 'text', text: 'a', marks: [{ type: 'bold' }] }, equation]);
    editor.commands.setTextSelection(3);
    editor.commands.unsetBold();
    editor.view.dispatch(editor.state.tr.insertText('c'));
    expect(editor.state.doc.nodeAt(3)?.marks).toEqual([]);
    editor.destroy();
});

test('bold over a range containing a page number marks the text, and one inserted with a mark loses it', () => {
    const pageNumber = { type: 'pageNumber', attrs: { kind: 'page' } };
    const editor = editorWith([{ type: 'text', text: 'a ' }, pageNumber, { type: 'text', text: ' b' }]);
    editor.chain().selectAll().setBold().run();
    editor.commands.insertContentAt(3, { ...pageNumber, marks: [{ type: 'italic' }] });
    expect(markedNodes(editor)).toEqual(['text', 'text']);
    editor.destroy();
});

test('bold and a comment over a range containing a chart mark the text, and one inserted with a mark loses it', () => {
    const chart = { type: 'chart', attrs: { spec: JSON.stringify(sampleChartSpec('bar')) } };
    const editor = editorWith([{ type: 'text', text: 'a ' }, chart, { type: 'text', text: ' b' }]);
    editor.chain().selectAll().setBold().setComment('card-1').run();
    editor.commands.insertContentAt(3, { ...chart, marks: [{ type: 'italic' }] });
    expect(markedNodes(editor)).toEqual(['text', 'text']);
    editor.destroy();
});
