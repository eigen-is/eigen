// The table of contents as the editor draws it: the body's headings to the node's level, following every edit, a
// collaborator's too, and a click that jumps to the heading.
import { afterEach, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const Y = await import('yjs');
const { Editor } = await import('@tiptap/react');
const { docEditorOptions } = await import('../../../../components/docs/doc-editor');
const { createDocUndoManager } = await import('../../../../components/docs/page-setup');

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

const jumps: number[] = [];

function body(doc = new Y.Doc()) {
    const editor: InstanceType<typeof Editor> = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        ...docEditorOptions({
            yDoc: doc,
            editable: true,
            target: { undoManager: createDocUndoManager(doc), cardIds: () => new Set() },
            caret: null,
            coarsePointer: false,
            tableOfContents: { onJump: (pos) => jumps.push(pos) },
            media: () => media,
            editor: () => editor,
        }),
    });
    editors.push(editor);
    return editor;
}

const text = (value: string): JSONContent => ({ type: 'text', text: value });
const heading = (level: number, value: string): JSONContent => ({
    type: 'heading',
    attrs: { level },
    content: [text(value)],
});
const paragraph = (value: string): JSONContent => ({ type: 'paragraph', content: [text(value)] });
const toc = (levels = 3): JSONContent => ({ type: 'tableOfContents', attrs: { levels } });

// Where the text of the body's block holding `text` ends.
function endOf(editor: InstanceType<typeof Editor>, text: string): number {
    let end = -1;
    editor.state.doc.forEach((node, pos) => {
        if (node.textContent === text) end = pos + node.nodeSize - 1;
    });
    return end;
}

const nav = (editor: InstanceType<typeof Editor>) =>
    editor.view.dom.querySelector('nav[data-type="table-of-contents"]');
const entries = (editor: InstanceType<typeof Editor>) =>
    [...(nav(editor)?.querySelectorAll('[data-level]') ?? [])].map((line) => [
        line.getAttribute('data-level'),
        line.textContent,
    ]);

test('lists the body headings to its level, each with its level for the indent', () => {
    const editor = body();
    editor.commands.setContent({
        type: 'doc',
        content: [toc(2), heading(1, 'Intro'), heading(3, 'Deep'), heading(2, 'Method'), paragraph('Text')],
    });
    expect(entries(editor)).toEqual([
        ['1', 'Intro'],
        ['2', 'Method'],
    ]);
});

test('with no headings it shows the placeholder, which the browser does not print', () => {
    const editor = body();
    editor.commands.setContent({ type: 'doc', content: [toc(), paragraph('Text')] });
    const placeholder = nav(editor)?.querySelector('p');
    expect(placeholder?.textContent).toBe('Headings you add appear here');
    expect(placeholder?.className).toContain('print:hidden');
});

test('follows a heading edited here, and typing in a paragraph draws it not again', () => {
    const editor = body();
    editor.commands.setContent({ type: 'doc', content: [toc(), paragraph('Text'), heading(1, 'Intro')] });
    const [line] = nav(editor)?.children ?? [];
    // In the paragraph, after "Text": every heading below moves, none changes.
    editor.commands.insertContentAt(6, ' more');
    expect(nav(editor)?.children[0]).toBe(line);
    // At the end of the heading.
    editor.commands.insertContentAt(endOf(editor, 'Intro'), ' and scope');
    expect(entries(editor)).toEqual([['1', 'Intro and scope']]);
});

test("follows a collaborator's rename and removal of a heading", () => {
    const doc = new Y.Doc();
    const peerDoc = new Y.Doc();
    doc.on('update', (update: Uint8Array) => Y.applyUpdate(peerDoc, update));
    peerDoc.on('update', (update: Uint8Array) => Y.applyUpdate(doc, update));
    const editor = body(doc);
    const peer = body(peerDoc);
    editor.commands.setContent({ type: 'doc', content: [toc(), heading(1, 'Intro'), heading(2, 'Method')] });
    expect(entries(peer)).toEqual([
        ['1', 'Intro'],
        ['2', 'Method'],
    ]);
    peer.commands.insertContentAt(endOf(peer, 'Method'), 's');
    expect(entries(editor)).toEqual([
        ['1', 'Intro'],
        ['2', 'Methods'],
    ]);
    const intro = peer.state.doc.child(1);
    peer.commands.deleteRange({ from: 1, to: 1 + intro.nodeSize });
    expect(entries(editor)).toEqual([['2', 'Methods']]);
});

test('a press on an entry jumps to its heading, counted past the deeper headings it leaves out', () => {
    const editor = body();
    editor.commands.setContent({
        type: 'doc',
        content: [toc(1), heading(2, 'Deep'), heading(1, 'Intro')],
    });
    const line = nav(editor)?.querySelector('[data-level="1"]');
    jumps.length = 0;
    line?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const pos = jumps.at(0);
    expect(pos === undefined ? null : editor.state.doc.nodeAt(pos)?.textContent).toBe('Intro');
});
