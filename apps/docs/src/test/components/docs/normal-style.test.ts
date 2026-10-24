// Format › Paragraph styles › Normal text › Update 'Normal text' to match: what the selection draws becomes the doc's
// Normal, one undo step of the body, and the content keeps its marks.
import { expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { Editor } = await import('@tiptap/react');
const { default: Collaboration } = await import('@tiptap/extension-collaboration');
const { prosemirrorJSONToYDoc } = await import('@tiptap/y-tiptap');
const { DEFAULT_NORMAL_STYLE, getDocExtensions, readNormalStyle, STYLE_ROOT } = await import(
    '@workspace/lib/docs/eigendoc'
);
const { createDocUndoManager } = await import('../../../components/docs/page-setup');
const { updateNormalStyle } = await import('../../../components/docs/normal-style');

const extensions = getDocExtensions();

// Word's body: Source Serif 4 at 12 pt, grey, line spacing 1.15, 3 pt before and 10 pt after.
const WORD_TEXT: JSONContent = {
    type: 'text',
    text: 'Body',
    marks: [{ type: 'textStyle', attrs: { fontFamily: 'Source Serif 4', fontSize: 12, color: '#333333' } }],
};
const wordParagraph = (attrs = { lineSpacing: 1.15, spaceBefore: 3, spaceAfter: 10 }): JSONContent => ({
    type: 'paragraph',
    attrs,
    content: [WORD_TEXT],
});

function mount(...content: JSONContent[]) {
    const doc = prosemirrorJSONToYDoc(getSchema(extensions), { type: 'doc', content }, 'default');
    const undoManager = createDocUndoManager(doc);
    const editor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        extensions: [...extensions, Collaboration.configure({ document: doc, yUndoOptions: { undoManager } })],
    });
    const normal = () => readNormalStyle(doc.getMap(STYLE_ROOT).toJSON());
    return { doc, undoManager, editor, normal };
}

test("the caret's text and paragraph become the Normal, an undo step of the body, and the content keeps its own", () => {
    const { doc, undoManager, editor, normal } = mount(wordParagraph());
    editor.commands.setTextSelection(2);
    const before = editor.getJSON();

    updateNormalStyle(doc, undoManager, editor, normal());
    expect(normal()).toEqual({
        font: 'Source Serif 4',
        size: 12,
        lineSpacing: 1.15,
        spaceBefore: 3,
        spaceAfter: 10,
        color: '#333333',
    });
    expect(editor.getJSON()).toEqual(before);

    // Again with nothing new writes nothing, so it is no step of its own.
    const steps = undoManager.undoStack.length;
    updateNormalStyle(doc, undoManager, editor, normal());
    expect(undoManager.undoStack.length).toBe(steps);

    expect(editor.commands.undo()).toBe(true);
    expect(normal()).toEqual(DEFAULT_NORMAL_STYLE);
    expect(doc.getMap(STYLE_ROOT).size).toBe(0);
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
});

test("unformatted text keeps the Normal's own, and only what differs is written", () => {
    const { doc, undoManager, editor, normal } = mount({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Plain' }],
    });
    editor.commands.setTextSelection(2);
    updateNormalStyle(doc, undoManager, editor, normal());
    expect(doc.getMap(STYLE_ROOT).size).toBe(0);

    doc.getMap(STYLE_ROOT).set('size', 12);
    updateNormalStyle(doc, undoManager, editor, normal());
    expect(doc.getMap(STYLE_ROOT).toJSON()).toEqual({ size: 12 });
    editor.destroy();
});

// A list owns the spacing of what it holds, so its item's paragraph draws none of its own.
test("in a list item the Normal keeps its spacing and takes the item's text and line spacing", () => {
    const { doc, undoManager, editor, normal } = mount({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [wordParagraph()] }],
    });
    editor.commands.setTextSelection(4);
    updateNormalStyle(doc, undoManager, editor, normal());
    expect(normal()).toEqual({
        ...DEFAULT_NORMAL_STYLE,
        font: 'Source Serif 4',
        size: 12,
        lineSpacing: 1.15,
        color: '#333333',
    });
    editor.destroy();
});

// getAttributes reads the first textStyle anywhere in a range; the Normal is the first text's look, whole.
test("a range takes its first text's font, size and colour, not a later run's", () => {
    const { doc, undoManager, editor, normal } = mount({
        type: 'paragraph',
        content: [
            { type: 'text', text: 'plain ' },
            {
                type: 'text',
                text: 'marked',
                marks: [{ type: 'textStyle', attrs: { fontFamily: 'JetBrains Mono', fontSize: 14, color: '#ff0000' } }],
            },
        ],
    });
    editor.commands.setTextSelection({ from: 2, to: 12 });
    updateNormalStyle(doc, undoManager, editor, normal());
    expect(normal()).toEqual(DEFAULT_NORMAL_STYLE);
    editor.destroy();
});

test("a colour or font the Normal can't hold keeps the Normal's own", () => {
    const { doc, undoManager, editor, normal } = mount({
        type: 'paragraph',
        content: [
            {
                type: 'text',
                text: 'Pasted',
                marks: [{ type: 'textStyle', attrs: { fontFamily: 'Comic Neue', color: 'rgb(255, 0, 0)' } }],
            },
        ],
    });
    doc.getMap(STYLE_ROOT).set('color', '#333333');
    doc.getMap(STYLE_ROOT).set('font', 'Source Serif 4');
    editor.commands.setTextSelection(2);
    updateNormalStyle(doc, undoManager, editor, normal());
    expect(normal()).toMatchObject({ color: '#333333', font: 'Source Serif 4' });
    editor.destroy();
});
