// One factory builds the body's editor and each band's. A band's editor binds its own root with its own undo, its schema
// deletes the nodes a band leaves out and keeps every mark, a paste into it drops comment anchors, and an image pasted
// into it lands in that editor.
import { afterEach, expect, mock, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const Y = await import('yjs');
const { Editor } = await import('@tiptap/react');
const { default: Collaboration } = await import('@tiptap/extension-collaboration');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { writeEigenClipboard } = await import('@workspace/lib/clipboard');
const { docEditorOptions } = await import('../../../components/docs/doc-editor');
const { createDocUndoManager } = await import('../../../components/docs/page-setup');

type Target = Parameters<typeof docEditorOptions>[0]['target'];

const pastedMediaName = mock(async () => 'logo-copy.png');
const media = {
    mediaFolderId: 'media',
    resolveMediaPath: () => undefined,
    uploadImage: async () => {},
    uploadSvg: async () => {},
    insertFromDrive: async () => {},
    replaceImage: async () => {},
    replaceFromDrive: async () => {},
    pastedMediaName,
};

const editors: InstanceType<typeof Editor>[] = [];
afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy();
    pastedMediaName.mockClear();
});

function mount(doc: InstanceType<typeof Y.Doc>, target: Target) {
    const editor: InstanceType<typeof Editor> = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        ...docEditorOptions({
            yDoc: doc,
            editable: true,
            target,
            caret: null,
            coarsePointer: false,
            textColumnWidth: () => 600,
            media: () => media,
            editor: () => editor,
        }),
    });
    editors.push(editor);
    return editor;
}

const body = (doc: InstanceType<typeof Y.Doc>, cardIds: string[] = []) =>
    mount(doc, { undoManager: createDocUndoManager(doc), cardIds: () => new Set(cardIds) });

const commentIds = (json: JSONContent): unknown[] => [
    ...(json.marks ?? []).filter((mark) => mark.type === 'comment').map((mark) => mark.attrs?.['cardId']),
    ...(json.content ?? []).flatMap(commentIds),
];

test("a band's editor writes its own root and undoes only its own typing", () => {
    const doc = new Y.Doc();
    const undoManager = createDocUndoManager(doc);
    const page = mount(doc, { undoManager, cardIds: () => new Set() });
    const header = mount(doc, { field: 'header' });

    page.commands.insertContent('Body');
    header.commands.insertContent('Acme');
    expect(doc.getXmlFragment('header').toString()).toBe('<paragraph>Acme</paragraph>');
    expect(page.getText()).toBe('Body');
    expect(undoManager.undoStack.length).toBe(1);

    expect(header.commands.undo()).toBe(true);
    expect(header.getText()).toBe('');
    expect(page.getText()).toBe('Body');
});

test("a band's editor deletes a node a band leaves out and keeps a comment's text", () => {
    const peer = new Y.Doc();
    const full = new Editor({
        extensions: [...getDocExtensions(), Collaboration.configure({ document: peer, field: 'header' })],
    });
    full.commands.setContent({
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Noted', marks: [{ type: 'comment', attrs: { cardId: 'c1' } }] }],
            },
            { type: 'pageBreak' },
        ],
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    full.destroy();

    const header = mount(doc, { field: 'header' });
    // The peer's TrailingNode wrote a paragraph after the break.
    expect(header.getJSON().content?.map((node) => node.type)).toEqual(['paragraph', 'paragraph']);
    expect(header.state.doc.textContent).toBe('Noted');
    expect(commentIds(header.getJSON())).toEqual(['c1']);
    expect(doc.getXmlFragment('header').toString()).not.toContain('pageBreak');
});

// Comments don't reach a band, so a pasted anchor would mark text no card points at.
test('a paste into a band drops comment anchors; the body keeps those of its own cards', () => {
    const html = '<p><span data-comment-id="c1">Noted</span></p>';
    const doc = new Y.Doc();
    const header = mount(doc, { field: 'header' });
    header.view.pasteHTML(html);
    expect(header.getText()).toBe('Noted');
    expect(commentIds(header.getJSON())).toEqual([]);

    const page = body(doc, ['c1']);
    page.view.pasteHTML(html);
    expect(commentIds(page.getJSON())).toEqual(['c1']);
});

test('an image pasted into a band lands in that editor, under the name its re-upload gives', async () => {
    const doc = new Y.Doc();
    body(doc);
    const header = mount(doc, { field: 'header' });
    const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true });
    writeEigenClipboard(event, {
        version: 1,
        items: [
            {
                type: 'image',
                mediaName: 'logo.png',
                sourcePathId: 'p',
                sourceParentId: 'elsewhere',
                sourceOwnerId: 'o',
                sourceMountId: 'm',
                width: 120,
                height: 40,
            },
        ],
    });
    header.view.dom.dispatchEvent(event);
    // insertEigenItems places the image once every re-upload has settled.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pastedMediaName).toHaveBeenCalledTimes(1);
    expect(doc.getXmlFragment('header').toString()).toContain('mediaName="logo-copy.png"');
    expect(doc.getXmlFragment('default').toString()).not.toContain('logo');
});
