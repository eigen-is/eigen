import { expect, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import { writeMathml } from '@workspace/math';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { Equation } from '../../../../components/docs/extensions/equation';

// An equation reads its stored MathML with DOMParser.
installHappyDom();

const mathml = writeMathml([{ kind: 'identifier', text: 'x' }], 'x');
const equation = { type: 'equation', attrs: { mathml } };

function editorWith(content: object[]) {
    return new Editor({
        extensions: [...getDocExtensions({ exclude: ['equation'] }), Equation],
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

// The Yjs binding would drop a mark on it, so the formatting would show until a reload and never reach a peer.
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
