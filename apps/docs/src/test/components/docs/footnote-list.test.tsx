// The notes under the text: numbered in document order, each drawn as the schema writes it, and the one open drawn by
// the note's live editor in its place.
import { afterEach, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { docEditorOptions } = await import('../../../components/docs/doc-editor');
const { createDocUndoManager } = await import('../../../components/docs/page-setup');
const { insertNote } = await import('../../../components/docs/extensions/footnote');
const { FootnoteList } = await import('../../../components/docs/footnote-list');
const { useOpenNote } = await import('../../../components/docs/hooks/use-open-note');

type TestEditor = InstanceType<typeof Editor>;
type Target = Parameters<typeof docEditorOptions>[0]['target'];

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

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function mount(doc: InstanceType<typeof Y.Doc>, target: Target): TestEditor {
    const editor: TestEditor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        ...docEditorOptions({
            yDoc: doc,
            editable: true,
            target,
            caret: null,
            coarsePointer: false,
            media: () => media,
            editor: () => editor,
        }),
    });
    cleanups.push(() => editor.destroy());
    return editor;
}

const text = (t: string): JSONContent => ({ type: 'text', text: t });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const footnote = (...content: JSONContent[]): JSONContent => ({ type: 'footnote', content });

async function setup() {
    const doc = new Y.Doc();
    const body = mount(doc, { undoManager: createDocUndoManager(doc), cardIds: () => new Set() });
    body.commands.setContent({
        type: 'doc',
        content: [
            paragraph(
                text('One'),
                footnote(paragraph(text('First note')), paragraph(text('its second paragraph'))),
                text(' two'),
                footnote(paragraph(text('Second note'))),
            ),
        ],
    });
    const note = mount(doc, { body: () => body, onLeave: () => {} });
    function Host() {
        const session = useOpenNote(body, note, true);
        return createElement(FootnoteList, {
            body,
            note,
            open: session.anchor,
            onOpen: (pos, at) => session.open(pos, { focus: true, at, selection: null }),
        });
    }
    const rendered = await renderInDocument(createElement(Host));
    cleanups.push(rendered.unmount);
    const items = () => [...rendered.container.querySelectorAll('li')];
    return { body, note, items };
}

test('the notes list in document order, numbered, a note with its paragraphs', async () => {
    const { items } = await setup();
    expect(items().map((li) => li.querySelector('.footnote-number')?.textContent)).toEqual(['1', '2']);
    expect([...(items()[0]?.querySelectorAll('p') ?? [])].map((p) => p.textContent)).toEqual([
        'First note',
        'its second paragraph',
    ]);
});

test("a press on a note opens it in the note's editor, in its place", async () => {
    const { note, items } = await setup();
    const second = items()[1]?.querySelector('.eigen-prose')?.parentElement;
    await act(async () => {
        second?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(items()[1]?.contains(note.view.dom)).toBe(true);
    expect(note.state.doc.textContent).toBe('Second note');
    expect(items()[0]?.textContent).toContain('First note');
});

test('a note inserted before the others takes number 1 and the others move up', async () => {
    const { body, items } = await setup();
    body.commands.setTextSelection(1);
    await act(async () => {
        insertNote(body);
    });
    expect(items().map((li) => li.textContent)).toEqual(['1', '2First noteits second paragraph', '3Second note']);
});

// Bold across a reference changes its note's marks and gives them back, and AtomMarks takes the reference's, steps that
// move no position: the list reads the doc as it is, not the nodes it last drew.
test('after Bold across the references a press on a note still opens it', async () => {
    const { body, note, items } = await setup();
    await act(async () => {
        body.commands.selectAll();
        body.commands.toggleBold();
    });
    const second = items()[1]?.querySelector('.eigen-prose')?.parentElement;
    await act(async () => {
        second?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(items()[1]?.contains(note.view.dom)).toBe(true);
    expect(note.state.doc.textContent).toBe('Second note');
});
