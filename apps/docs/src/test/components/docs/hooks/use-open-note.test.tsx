// The open footnote: one live editor on the note, its edits forwarded into the body by diff, the body's changes pulled
// back, anchored on the note's Yjs element, one history with the body, and the find bar's matches and reveal. Two
// Y.Docs synced by hand stand in for two tabs.
import { afterEach, expect, spyOn, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { yUndoPluginKey } = await import('@tiptap/y-tiptap');
const { SearchHighlight } = await import('@workspace/ui/components/search/prosemirror-search-highlight');
const { useProseMirrorSearchController } = await import(
    '@workspace/ui/components/search/prosemirror-search-controller'
);
const { docEditorOptions } = await import('../../../../components/docs/doc-editor');
const { createDocUndoManager } = await import('../../../../components/docs/page-setup');
const { useOpenNote } = await import('../../../../components/docs/hooks/use-open-note');

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

function mount(doc: InstanceType<typeof Y.Doc>, target: Target, extensions = [SearchHighlight]): TestEditor {
    const editor: TestEditor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        ...docEditorOptions({
            yDoc: doc,
            editable: true,
            target,
            caret: null,
            coarsePointer: false,
            extensions,
            media: () => media,
            editor: () => editor,
        }),
    });
    cleanups.push(() => editor.destroy());
    return editor;
}

const bodyOn = (doc: InstanceType<typeof Y.Doc>) =>
    mount(doc, { undoManager: createDocUndoManager(doc), cardIds: () => new Set() });

const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({
    type: 'text',
    text: t,
    ...(marks && { marks }),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const footnote = (...content: JSONContent[]): JSONContent => ({ type: 'footnote', content });

// "Claim" 1..6, the note at 6 holding "Hello world" (8..19), ". More" from 21.
const DOC = [paragraph(text('Claim'), footnote(paragraph(text('Hello world'))), text('. More'))];

type Session = ReturnType<typeof useOpenNote>;

// Tab A's body and note editors with the hook, tab B a plain body on a synced doc.
async function setup(content: JSONContent[] = DOC) {
    const yA = new Y.Doc();
    const yB = new Y.Doc();
    yA.on('update', (update: Uint8Array, origin: unknown) => origin !== 'peer' && Y.applyUpdate(yB, update, 'peer'));
    yB.on('update', (update: Uint8Array, origin: unknown) => origin !== 'peer' && Y.applyUpdate(yA, update, 'peer'));
    const a = bodyOn(yA);
    const b = bodyOn(yB);
    a.commands.setContent({ type: 'doc', content });
    const undoManager = yUndoPluginKey.getState(a.state)?.undoManager;
    if (!undoManager) throw new Error('no undo manager');
    undoManager.clear();
    const leaving = { current: () => {} };
    const note = mount(yA, { body: () => a, onLeave: () => leaving.current() }, []);
    const session: { current: Session | null; search: ReturnType<typeof useProseMirrorSearchController> | null } = {
        current: null,
        search: null,
    };
    function Host() {
        session.current = useOpenNote(a, note, true);
        session.search = useProseMirrorSearchController(a, true);
        leaving.current = session.current.leave;
        return null;
    }
    const rendered = await renderInDocument(createElement(Host));
    cleanups.push(rendered.unmount);
    const open = async (pos: number) => {
        await act(async () => session.current?.open(pos, { focus: true, at: null, selection: null }));
    };
    return { a, b, note, yA, yB, undoManager, session, open };
}

const noteOf = (editor: TestEditor, index = 0) => {
    const notes: string[] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'footnote')
            notes.push(
                node.content
                    .toJSON()
                    .map((p: JSONContent) => p.content?.map((t) => t.text).join('') ?? '')
                    .join('|'),
            );
    });
    return notes[index];
};

const typeInto = (editor: TestEditor, chars: string) => {
    for (const char of chars) editor.view.dispatch(editor.state.tr.insertText(char));
};

// prosemirror-keymap reads the platform once, maybe before happy-dom's, so ⌘ or Ctrl, whichever it takes as Mod; a
// keydown no keymap takes falls through to the next. True when one was handled.
const press = (editor: TestEditor, key: string, shift = false) =>
    [true, false].some((meta) => {
        const event = new KeyboardEvent('keydown', {
            key,
            metaKey: meta,
            ctrlKey: !meta,
            shiftKey: shift,
            bubbles: true,
            cancelable: true,
        });
        editor.view.dom.dispatchEvent(event);
        return event.defaultPrevented;
    });

test("typing and Enter in the open note reach the other tab, and the note's editor holds the note", async () => {
    const { a, b, note, open } = await setup();
    await open(6);
    expect(note.state.doc.textContent).toBe('Hello world');
    note.commands.setTextSelection(7);
    typeInto(note, 'big ');
    expect(noteOf(a)).toBe('Hello big world');
    expect(noteOf(b)).toBe('Hello big world');
    note.commands.splitBlock();
    typeInto(note, 'two');
    expect(noteOf(b)).toBe('Hello big |twoworld');
});

test('⌘B, ⌘I and ⌘U format the note and forward', async () => {
    const { b, note, open } = await setup();
    await open(6);
    note.commands.setTextSelection({ from: 1, to: 6 });
    expect(press(note, 'b')).toBe(true);
    expect(press(note, 'i')).toBe(true);
    expect(press(note, 'u')).toBe(true);
    let marks: string[] = [];
    b.state.doc.descendants((node) => {
        if (node.isText && node.text === 'Hello') marks = node.marks.map((mark) => mark.type.name);
    });
    expect(marks).toEqual(['bold', 'italic', 'underline']);
});

test("⌘Z in the note undoes the note's last burst through the body's history, and the caret stays where it was", async () => {
    const { a, note, undoManager, open } = await setup();
    await open(6);
    note.commands.setTextSelection(12);
    typeInto(note, ' one');
    undoManager.stopCapturing();
    typeInto(note, ' two');
    expect(undoManager.undoStack.length).toBe(2);

    expect(press(note, 'z')).toBe(true);
    expect(noteOf(a)).toBe('Hello world one');
    expect(note.state.doc.textContent).toBe('Hello world one');
    expect(note.state.selection.from).toBe(16);
    expect(press(note, 'z', true)).toBe(true);
    expect(note.state.doc.textContent).toBe('Hello world one two');
    // The body's ⌘Z walks the same history.
    a.commands.undo();
    expect(note.state.doc.textContent).toBe('Hello world one');
});

// TipTap replays a transaction its command captured without the transaction's meta.
test('a replayed transaction forwards nothing twice', async () => {
    const { a, note, open } = await setup();
    await open(6);
    note.commands.setTextSelection(12);
    typeInto(note, '!');
    // ⌘ and Ctrl, as press's: the keymap takes one as Mod, and the command returns true either way.
    note.commands.keyboardShortcut('Meta-z');
    note.commands.keyboardShortcut('Ctrl-z');
    expect(noteOf(a)).toBe('Hello world');
    expect(note.state.doc.textContent).toBe('Hello world');
});

test("a peer's edit to the open note moves the caret with the text, and one after it leaves it", async () => {
    const { a, b, note, open } = await setup();
    await open(6);
    note.commands.setTextSelection(7);
    b.view.dispatch(b.state.tr.insertText('Oh, ', 8));
    expect(noteOf(a)).toBe('Oh, Hello world');
    expect(note.state.selection.from).toBe(11);
    b.view.dispatch(b.state.tr.insertText('!', 8 + 'Oh, Hello world'.length));
    expect(note.state.selection.from).toBe(11);
    typeInto(note, 'X');
    expect(noteOf(b)).toBe('Oh, Hello Xworld!');
});

// y-tiptap builds every node anew on a peer's update, and ProseMirror keeps the view of a node equal to the one it drew,
// so a reference's view can hold a node the doc no longer does.
test("a peer's edit elsewhere keeps the note open", async () => {
    const { b, note, session, open } = await setup();
    await open(6);
    await act(async () => {
        b.view.dispatch(b.state.tr.insertText('Big ', 1));
    });
    expect(session.current?.anchor).not.toBeNull();
    note.commands.setTextSelection(12);
    typeInto(note, '!');
    expect(noteOf(b)).toBe('Hello world!');
});

test.each([
    ["a peer's edit", ({ b }: Awaited<ReturnType<typeof setup>>) => b.view.dispatch(b.state.tr.insertText('Big ', 1))],
    [
        'Bold across its reference',
        ({ a }: Awaited<ReturnType<typeof setup>>) => {
            a.commands.selectAll();
            a.commands.toggleBold();
        },
    ],
    [
        "⌘Z of the body's edit",
        ({ a, undoManager }: Awaited<ReturnType<typeof setup>>) => {
            a.commands.setTextSelection(1);
            a.commands.insertContent('X');
            undoManager.stopCapturing();
            a.commands.undo();
        },
    ],
])('a note opens after %s', async (_, change) => {
    const context = await setup();
    const { a, b, note, session, open } = context;
    await act(async () => change(context));
    let pos = -1;
    a.state.doc.descendants((node, at) => {
        if (node.type.name === 'footnote') pos = at;
    });
    await open(pos);
    expect(session.current?.anchor).not.toBeNull();
    note.commands.setTextSelection(12);
    typeInto(note, '!');
    expect(noteOf(b)).toBe('Hello world!');
});

test('Enter before the reference, here and in the other tab, keeps the note open on its Yjs element', async () => {
    const { a, b, note, session, open } = await setup();
    await open(6);
    a.commands.setTextSelection(3);
    a.commands.splitBlock();
    b.view.dispatch(b.state.tr.split(2));
    expect(session.current?.anchor).not.toBeNull();
    note.commands.setTextSelection(6);
    typeInto(note, '!');
    expect(noteOf(b)).toBe('Hello! world');
});

// Two notes alike, and Enter between them: the binding keeps the first half's elements and gives the second note a new
// one. The open note is the node ProseMirror kept, not the first whose text matches.
test('Enter between two notes alike keeps the second open', async () => {
    const { a, b, note, session, open } = await setup([
        paragraph(text('Cl'), footnote(paragraph(text('Same'))), text('aim'), footnote(paragraph(text('Same')))),
    ]);
    let second = -1;
    a.state.doc.descendants((node, pos) => {
        if (node.type.name === 'footnote') second = pos;
    });
    await open(second);
    // "Cl" 1..3, the first note 3..11, "aim" 11..14: Enter after its "a".
    a.commands.setTextSelection(12);
    a.commands.splitBlock();
    expect(session.current?.anchor).not.toBeNull();
    note.commands.setTextSelection(5);
    typeInto(note, '!');
    expect(noteOf(b, 0)).toBe('Same');
    expect(noteOf(b, 1)).toBe('Same!');
});

test('a body editor built anew finds the open note on the same Yjs element', async () => {
    const { yA, note, session, open } = await setup();
    await open(6);
    const anchor = session.current?.anchor;
    if (!anchor) throw new Error('no note open');
    const { findNote } = await import('../../../../components/docs/extensions/footnote');
    const rebuilt = bodyOn(yA);
    expect(findNote(rebuilt, anchor)?.pos).toBe(6);
    expect(note.isDestroyed).toBe(false);
});

test('deleting the reference, here or in the other tab, closes the note', async () => {
    const { a, b, session, open } = await setup([
        paragraph(text('One'), footnote(paragraph(text('first'))), text(' two'), footnote(paragraph(text('second')))),
    ]);
    await open(4);
    await act(async () => {
        a.view.dispatch(a.state.tr.delete(4, 4 + (a.state.doc.nodeAt(4)?.nodeSize ?? 0)));
    });
    expect(session.current?.anchor).toBeNull();
    expect(noteOf(b)).toBe('second');

    let last = -1;
    a.state.doc.descendants((node, pos) => {
        if (node.type.name === 'footnote') last = pos;
    });
    await open(last);
    await act(async () => {
        b.view.dispatch(b.state.tr.delete(last, last + (b.state.doc.nodeAt(last)?.nodeSize ?? 0)));
    });
    expect(session.current?.anchor).toBeNull();
    // ⌘Z in this tab brings its own delete back.
    a.commands.undo();
    expect(noteOf(a)).toBe('first');
});

test('Esc leaves the note with the caret right after the reference', async () => {
    const { a, note, session, open } = await setup();
    await open(6);
    await act(async () => {
        note.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(session.current?.anchor).toBeNull();
    expect(a.state.selection.from).toBe(6 + (a.state.doc.nodeAt(6)?.nodeSize ?? 0));
});

test("the find bar counts a note's text, paints it in the open note, and its reveal opens a closed one", async () => {
    const { a, note, session } = await setup([
        paragraph(
            text('world'),
            footnote(paragraph(text('Hello world'))),
            text(' and'),
            footnote(paragraph(text('a world'))),
        ),
    ]);
    const search = session.search;
    if (!search) throw new Error('no search');
    const options = { matchCase: false, wholeWord: false, regex: false };
    const matches = search.search('world', options);
    expect(matches.length).toBe(3);
    search.highlightAll(matches);

    await act(async () => search.reveal(matches[2].id));
    expect(session.current?.anchor).not.toBeNull();
    expect(note.state.doc.textContent).toBe('a world');
    expect(note.state.doc.textBetween(note.state.selection.from, note.state.selection.to)).toBe('world');
    expect(note.view.dom.querySelector('.ProseMirror-active-search-match')?.textContent).toBe('world');

    await act(async () => search.reveal(matches[1].id));
    expect(note.state.doc.textContent).toBe('Hello world');
    expect(note.view.dom.querySelector('.ProseMirror-active-search-match')?.textContent).toBe('world');

    // A match in the body's text leaves the note.
    await act(async () => search.reveal(matches[0].id));
    expect(session.current?.anchor).toBeNull();
    // Replace all reaches the notes' text too.
    search.replaceAll?.('world', 'earth', options, false);
    expect(noteOf(a, 0)).toBe('Hello earth');
});

test('a note pasted into a note leaves its text in its place', async () => {
    const { a, note, open } = await setup();
    await open(6);
    note.commands.setTextSelection(12);
    note.view.pasteHTML(
        '<p>see<span class="footnote" data-type="footnote"><span data-type="footnote-paragraph">inner</span><span data-type="footnote-paragraph">two</span></span></p>',
    );
    expect(noteOf(a)).toBe('Hello worldsee inner two');
    let notes = 0;
    a.state.doc.descendants((node) => {
        if (node.type.name === 'footnote') notes++;
    });
    expect(notes).toBe(1);
});

// The body's text before a reference and a note's first word read as one in ProseMirror's text: "gamma." and "Se" made
// gamma.Se, a link, in the body. The note's editor makes its own links.
test("typing in a note makes no link of the body's text before its reference", async () => {
    const { a, b, note, open } = await setup([paragraph(text('Alpha gamma.'), footnote(paragraph()))]);
    await open(13);
    typeInto(note, 'See ');
    typeInto(note, 'more');
    expect(noteOf(b)).toBe('See more');
    const links: string[] = [];
    a.state.doc.descendants((node) => {
        if (node.marks.some((mark) => mark.type.name === 'link')) links.push(node.text ?? node.type.name);
    });
    expect(links).toEqual([]);
});

test("text typed after a reference never joins its note's text in a link or a rule", async () => {
    const { a } = await setup([paragraph(text('See'), footnote(paragraph(text('example (c'))))]);
    const end = a.state.doc.firstChild?.nodeSize ?? 0;
    a.commands.setTextSelection(end - 1);
    // As a keystroke: the input rules first, else the text.
    for (const char of ').com ') {
        const { from, to } = a.state.selection;
        const ruled = a.view.someProp('handleTextInput', (f) =>
            f(a.view, from, to, char, () => a.state.tr.insertText(char)),
        );
        if (!ruled) a.view.dispatch(a.state.tr.insertText(char));
    }
    expect(a.state.doc.textContent).toBe('Seeexample (c).com ');
    let links = 0;
    a.state.doc.descendants((node) => {
        if (node.marks.some((mark) => mark.type.name === 'link')) links++;
    });
    expect(links).toBe(0);
});

test("a peer's delete of the open note's reference hands the caret to the body where it stood", async () => {
    const { a, b, note, session, open } = await setup();
    await open(6);
    expect(note.view.hasFocus()).toBe(true);
    await act(async () => {
        b.view.dispatch(b.state.tr.delete(6, 6 + (b.state.doc.nodeAt(6)?.nodeSize ?? 0)));
    });
    expect(session.current?.anchor).toBeNull();
    expect(a.view.hasFocus()).toBe(true);
    expect(a.state.selection.from).toBe(6);
});

// ⌘Z in a note that undoes the note's own insert closes it; the body takes the caret, so ⇧⌘Z brings the note back.
test('undo in a note that removes the note leaves the caret in the body, where redo works', async () => {
    const { a, note, session, undoManager } = await setup([paragraph(text('Claim'))]);
    const { insertNote } = await import('../../../../components/docs/extensions/footnote');
    a.commands.setTextSelection(6);
    let pos: number | null = null;
    await act(async () => {
        pos = insertNote(a);
    });
    const inserted = pos;
    if (inserted === null) throw new Error('no note');
    await act(async () => session.current?.open(inserted, { focus: true, at: null, selection: null }));
    undoManager.stopCapturing();
    // The note's ⌘Z is handled, so the browser's own undo never runs, and the body takes the focus only in a frame after
    // the transaction: Chrome throws drawing a selection inside it, and the keymap would then never return. The test
    // DOM runs a frame at once, so the frames wait here.
    const frames: FrameRequestCallback[] = [];
    const frame = spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
    let handled = false;
    try {
        await act(async () => {
            handled = press(note, 'z');
        });
        expect(handled).toBe(true);
        expect(session.current?.anchor).toBeNull();
        expect(a.view.hasFocus()).toBe(false);
        await act(async () => {
            for (let callback = frames.shift(); callback; callback = frames.shift()) callback(0);
        });
    } finally {
        frame.mockRestore();
    }
    expect(a.view.hasFocus()).toBe(true);
    expect(a.state.selection.from).toBe(6);
    await act(async () => {
        press(a, 'z', true);
    });
    expect(noteOf(a)).toBe('');
});
