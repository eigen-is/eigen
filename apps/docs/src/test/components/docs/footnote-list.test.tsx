// The notes under the text: numbered in document order, each drawn as the schema writes it, and the one open drawn by
// the note's live editor in its place.
import { afterEach, expect, spyOn, test } from 'bun:test';
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

async function setup(second: JSONContent = paragraph(text('Second note'))) {
    const doc = new Y.Doc();
    const body = mount(doc, { undoManager: createDocUndoManager(doc), cardIds: () => new Set() });
    body.commands.setContent({
        type: 'doc',
        content: [
            paragraph(
                text('One'),
                footnote(paragraph(text('First note')), paragraph(text('its second paragraph'))),
                text(' two'),
                footnote(second),
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

// A note is keyed by its Yjs element, so a note put in or taken out before the open one leaves its editor mounted.
test('a note put in and taken out before the open one keeps its editor, its focus and its typing', async () => {
    const { body, note, items } = await setup();
    const second = items()[1]?.querySelector('.eigen-prose')?.parentElement;
    await act(async () => {
        second?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    const live = items()[1];
    expect(live?.contains(note.view.dom)).toBe(true);
    expect(note.view.hasFocus()).toBe(true);
    const earlier = body.schema.nodeFromJSON(footnote(paragraph(text('Earlier'))));
    await act(async () => {
        body.view.dispatch(body.state.tr.insert(1, earlier));
    });
    expect(items()[2]).toBe(live);
    expect(note.view.hasFocus()).toBe(true);
    await act(async () => {
        body.view.dispatch(body.state.tr.delete(1, 1 + earlier.nodeSize));
    });
    expect(items()[1]).toBe(live);
    expect(note.view.hasFocus()).toBe(true);
    note.commands.insertContentAt(note.state.doc.content.size - 1, '!');
    expect(body.state.doc.textContent).toContain('Second note!');
});

// The prose stylesheet gives a figure its own line by its data-layout, which a closed note's HTML must carry for a block
// image too, or it draws beside the note's text until the note opens.
test("a closed note's block image carries its layout, so it draws on a line of its own", async () => {
    const { items } = await setup(paragraph(text('See'), { type: 'figure', attrs: { mediaName: 'logo.png' } }));
    expect(items()[1]?.querySelector('.figure')?.getAttribute('data-layout')).toBe('block');
});

// React draws an image's node view; mounted inside a layout effect, its flushSync draws a warning, and here it mounts
// as the note opens.
test('a note holding an image opens with no flushSync from a layout effect', async () => {
    const { items, note } = await setup(paragraph(text('See'), { type: 'figure', attrs: { mediaName: 'logo.png' } }));
    const errors = spyOn(console, 'error');
    try {
        const second = items()[1]?.querySelector('.eigen-prose')?.parentElement;
        await act(async () => {
            second?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        });
        expect(items()[1]?.contains(note.view.dom)).toBe(true);
        expect(errors.mock.calls.filter((call) => String(call[0]).includes('flushSync'))).toEqual([]);
    } finally {
        errors.mockRestore();
    }
});
