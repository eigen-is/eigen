// The body's footnote reference: its number from footnoteNumbers, and a body-range format or comment that never marks
// the note's text, as in Google Docs.
import { afterEach, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const Y = await import('yjs');
const { Editor } = await import('@tiptap/react');
const { docEditorOptions } = await import('../../../../components/docs/doc-editor');
const { createDocUndoManager } = await import('../../../../components/docs/page-setup');
const { canAnchorComment } = await import('../../../../components/docs/extensions/comment-mark');
const { insertNote } = await import('../../../../components/docs/extensions/footnote');

const media = {
    mediaFolderId: 'media',
    resolveMediaPath: () => undefined,
    uploadImage: async () => {},
    uploadSvg: async () => {},
    insertFromDrive: async () => {},
    replaceImage: async () => {},
    replaceFromDrive: async () => {},
    pastedMediaName: async () => null,
};

const editors: InstanceType<typeof Editor>[] = [];
afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy();
});

const opened: number[] = [];

function body(content: JSONContent[]) {
    const doc = new Y.Doc();
    const editor: InstanceType<typeof Editor> = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        ...docEditorOptions({
            yDoc: doc,
            editable: true,
            target: { undoManager: createDocUndoManager(doc), cardIds: () => new Set(['c1']) },
            caret: null,
            coarsePointer: false,
            footnote: { onOpen: (pos) => opened.push(pos) },
            media: () => media,
            editor: () => editor,
        }),
    });
    editor.commands.setContent({ type: 'doc', content });
    editors.push(editor);
    return editor;
}

const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({
    type: 'text',
    text: t,
    ...(marks && { marks }),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const footnote = (...content: JSONContent[]): JSONContent => ({ type: 'footnote', content });

// "Claim" 1..6, the note at 6 holding "Hello world" (8..19), ". More" from 21.
const DOC = [paragraph(text('Claim'), footnote(paragraph(text('Hello world'))), text('. More'))];

const numbers = (editor: InstanceType<typeof Editor>) =>
    [...editor.view.dom.querySelectorAll('sup.footnote-ref')].map((sup) => sup.textContent);

const noteJSON = (editor: InstanceType<typeof Editor>, index = 0) => {
    const notes: JSONContent[] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'footnote') notes.push(node.toJSON());
    });
    return notes[index];
};

test('a reference draws its number in document order, and an insert before it renumbers it', () => {
    const editor = body(DOC);
    expect(numbers(editor)).toEqual(['1']);
    // The note's text is not the body's DOM.
    expect(editor.view.dom.textContent).toBe('Claim1. More');

    editor.commands.setTextSelection(3);
    expect(insertNote(editor)).toBe(3);
    expect(numbers(editor)).toEqual(['1', '2']);
    expect(editor.state.selection.from).toBe(3 + (editor.state.doc.nodeAt(3)?.nodeSize ?? 0));
});

test('no note goes in a code block', () => {
    const editor = body([{ type: 'codeBlock', content: [text('x')] }]);
    editor.commands.setTextSelection(2);
    expect(insertNote(editor)).toBeNull();
});

test('a press on a reference opens its note', () => {
    opened.length = 0;
    const editor = body(DOC);
    const sup = editor.view.dom.querySelector('sup.footnote-ref');
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    sup?.dispatchEvent(press);
    expect(opened).toEqual([6]);
    expect(press.defaultPrevented).toBe(true);
});

test('bold, a colour and a comment across a reference leave the note as it was', () => {
    const editor = body([
        paragraph(
            text('Claim'),
            footnote(paragraph(text('Hello '), text('world', [{ type: 'bold' }]))),
            text('. More'),
        ),
    ]);
    const before = noteJSON(editor);
    editor.commands.selectAll();
    editor.commands.toggleBold();
    editor.commands.setColor('#ff0000');
    editor.commands.setComment('c1');
    expect(noteJSON(editor)).toEqual(before);
    const firstText = editor.state.doc.firstChild?.firstChild;
    expect(firstText?.marks.map((mark) => mark.type.name).sort()).toEqual(['bold', 'comment', 'textStyle']);

    // Bold off across it keeps the note's own bold.
    editor.commands.selectAll();
    editor.commands.toggleBold();
    expect(noteJSON(editor)).toEqual(before);
});

test("clear formatting across a reference keeps the note's marks and alignment", () => {
    const editor = body([
        paragraph(
            text('Claim', [{ type: 'italic' }]),
            footnote({
                type: 'paragraph',
                attrs: { textAlign: 'center' },
                content: [text('Note', [{ type: 'bold' }])],
            }),
        ),
    ]);
    const before = noteJSON(editor);
    editor.chain().selectAll().clearNodes().unsetAllMarks().run();
    expect(noteJSON(editor)).toEqual(before);
    expect(editor.state.doc.firstChild?.firstChild?.marks).toEqual([]);
});

test("find and replace still edits a note's text", () => {
    const editor = body(DOC);
    editor.view.dispatch(editor.state.tr.insertText('there', 14, 19));
    expect(noteJSON(editor)?.content?.[0]?.content).toEqual([text('Hello there')]);
});

test('a reference selected alone takes no comment; text beside it does', () => {
    const editor = body(DOC);
    editor.commands.setNodeSelection(6);
    expect(canAnchorComment(editor.state)).toBe(false);
    editor.commands.setTextSelection({ from: 5, to: 22 });
    expect(canAnchorComment(editor.state)).toBe(true);
});
