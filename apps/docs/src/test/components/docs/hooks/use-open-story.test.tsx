// The open story: one live editor on a note or a text box, its edits forwarded into the body by diff, the body's changes
// pulled back, anchored on the story's Yjs element and found again by its id, one history with the body, and the find
// bar's matches and reveal. Two Y.Docs synced by hand stand in for two tabs.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
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
const { useOpenStory } = await import('../../../../components/docs/hooks/use-open-story');

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

type Session = ReturnType<typeof useOpenStory>;

// Tab A's body and note editors with the hook, tab B a plain body on a synced doc.
async function setup(content: JSONContent[] = DOC) {
    const yA = new Y.Doc();
    const yB = new Y.Doc();
    // While held, each tab's updates wait, as two tabs' edits cross on the wire.
    const link = { held: false, queue: [] as (() => void)[] };
    const send = (to: InstanceType<typeof Y.Doc>) => (update: Uint8Array, origin: unknown) => {
        if (origin === 'peer') return;
        if (link.held) link.queue.push(() => Y.applyUpdate(to, update, 'peer'));
        else Y.applyUpdate(to, update, 'peer');
    };
    yA.on('update', send(yB));
    yB.on('update', send(yA));
    const hold = () => {
        link.held = true;
    };
    const release = async () => {
        link.held = false;
        await act(async () => {
            for (const apply of link.queue.splice(0)) apply();
        });
        // The renewed story forwards its text once the change that moved it is done.
        await act(async () => {
            await Promise.resolve();
        });
    };
    const a = bodyOn(yA);
    const b = bodyOn(yB);
    a.commands.setContent({ type: 'doc', content });
    const undoManager = yUndoPluginKey.getState(a.state)?.undoManager;
    if (!undoManager) throw new Error('no undo manager');
    undoManager.clear();
    const leaving = { current: () => {} };
    const note = mount(yA, { body: () => a, onLeave: () => leaving.current(), story: 'footnote' }, []);
    const box = mount(yA, { body: () => a, onLeave: () => leaving.current(), story: 'textBox' }, []);
    const editors = { footnote: note, textBox: box };
    const session: { current: Session | null; search: ReturnType<typeof useProseMirrorSearchController> | null } = {
        current: null,
        search: null,
    };
    function Host() {
        session.current = useOpenStory(a, editors, true);
        session.search = useProseMirrorSearchController(a, true);
        leaving.current = session.current.leave;
        return null;
    }
    const rendered = await renderInDocument(createElement(Host));
    cleanups.push(rendered.unmount);
    const open = async (pos: number) => {
        await act(async () => session.current?.open(pos, { focus: true, at: null, selection: null }));
    };
    return { a, b, note, box, yA, yB, undoManager, session, open, hold, release };
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
    const { findStory } = await import('../../../../components/docs/extensions/story');
    const rebuilt = bodyOn(yA);
    expect(findStory(rebuilt, anchor)?.pos).toBe(6);
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

const linksIn = (editor: TestEditor) => {
    const links: string[] = [];
    editor.state.doc.descendants((node) => {
        if (node.marks.some((mark) => mark.type.name === 'link')) links.push(node.text ?? node.type.name);
    });
    return links;
};

// y-tiptap applies a peer's change and an undo as a replace of the whole doc, which autolink read as the first
// textblock typed anew.
test("a peer's edit and an undo link nothing their writer never linked", async () => {
    const { a, b, undoManager } = await setup([paragraph(text('see plan.md')), paragraph(text('More'))]);
    a.chain().selectAll().unsetLink().run();
    undoManager.clear();
    expect(linksIn(b)).toEqual([]);
    a.view.dispatch(a.state.tr.insertText('!', a.state.doc.content.size - 1));
    expect(b.state.doc.textContent).toBe('see plan.mdMore!');
    undoManager.undo();
    expect(a.state.doc.textContent).toBe('see plan.mdMore');
    expect([linksIn(a), linksIn(b)]).toEqual([[], []]);
});

// A pull is the body's change: the note's own autolink would link what a peer left unlinked.
test('a pull into the open note links nothing', async () => {
    const { a, b, note, open } = await setup([paragraph(text('Claim'), footnote(paragraph(text('see plan.md'))))]);
    a.chain().selectAll().unsetLink().run();
    await open(6);
    b.view.dispatch(b.state.tr.insertText(' ', 8 + 'see plan.md'.length).setMeta('preventAutolink', true));
    expect(note.state.doc.textContent).toBe('see plan.md ');
    expect([linksIn(note), linksIn(a), linksIn(b)]).toEqual([[], [], []]);
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

// The anchor is the note's own Yjs element: never the text before the reference, nor a neighbour once the note is gone.
test('a peer typing right before the reference keeps the note open', async () => {
    const { b, note, session, open } = await setup();
    await open(6);
    await act(async () => {
        b.view.dispatch(b.state.tr.insertText('ed', 6));
    });
    expect(session.current?.anchor).not.toBeNull();
    note.commands.setTextSelection(12);
    typeInto(note, '!');
    expect(noteOf(b)).toBe('Hello world!');
});

test("a peer's delete of the open first of two adjacent notes closes it, and never opens the second", async () => {
    const { a, b, note, session, open } = await setup([
        paragraph(text('Claim'), footnote(paragraph(text('First'))), footnote(paragraph(text('Second')))),
    ]);
    await open(6);
    await act(async () => {
        b.view.dispatch(b.state.tr.delete(6, 6 + (b.state.doc.nodeAt(6)?.nodeSize ?? 0)));
    });
    expect(session.current?.anchor).toBeNull();
    expect(a.view.hasFocus()).toBe(true);
    typeInto(note, 'X');
    expect(noteOf(a)).toBe('Second');
});

test('⌘Z of a note inserted right before another reference closes it, and never opens the other', async () => {
    const { a, note, session, undoManager } = await setup([paragraph(text('Claim'), footnote(paragraph(text('Old'))))]);
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
    await act(async () => {
        press(note, 'z');
    });
    expect(session.current?.anchor).toBeNull();
    expect(noteOf(a)).toBe('Old');
    expect(noteOf(a, 1)).toBeUndefined();
});

// A cut and a paste of a reference in another tab gives its note a new Yjs element, and keystrokes made meanwhile went
// into the old one. The note's id finds the new node, and the open editor puts its text back.
describe("a peer's cut and paste of the open note's reference", () => {
    const moved = (id: string | null) => [
        paragraph(text('One')),
        paragraph(text('Two'), { ...footnote(paragraph(text('Note'))), attrs: { id } }, text('.')),
    ];
    const cutAndPaste = (b: TestEditor) => {
        const node = b.state.doc.nodeAt(9);
        if (!node) throw new Error('no note');
        b.view.dispatch(b.state.tr.delete(9, 9 + node.nodeSize).insert(4, node));
    };

    test('keeps it open, and what was typed meanwhile reaches both tabs', async () => {
        const { a, b, note, session, open, hold, release } = await setup(moved('n1'));
        await open(9);
        hold();
        await act(async () => {
            cutAndPaste(b);
            note.commands.setTextSelection(5);
            typeInto(note, '!');
        });
        await release();
        expect(session.current?.anchor?.pos).toBe(4);
        expect(noteOf(a)).toBe('Note!');
        expect(noteOf(b)).toBe('Note!');
        typeInto(note, '?');
        expect(noteOf(b)).toBe('Note!?');
    });

    // A body transaction that changes no text, as a peer's caret moving makes, pulls nothing into the note: what was
    // typed stays the typist's.
    test('keeps what was typed meanwhile when a peer caret moved before the paste arrived', async () => {
        const { a, b, note, open, hold, release } = await setup(moved('n1'));
        await open(9);
        hold();
        await act(async () => {
            cutAndPaste(b);
            note.commands.setTextSelection(5);
            typeInto(note, '!');
            a.view.dispatch(a.state.tr.setMeta('peerCaret', true));
        });
        await release();
        expect(noteOf(a)).toBe('Note!');
        expect(noteOf(b)).toBe('Note!');
    });

    // The note's editor already holds the second note's text, typed into the first: opening the second brings nothing
    // into it, yet nothing was typed there.
    test("takes a peer's text into a note opened on an editor that held its text already", async () => {
        const { a, yA, note, session, open } = await setup([
            paragraph(text('One')),
            paragraph(text('Two'), { ...footnote(paragraph(text('Note'))), attrs: { id: 'n1' } }, text('.')),
            paragraph(text('Three'), { ...footnote(paragraph(text('Note!'))), attrs: { id: 'n2' } }),
        ]);
        await open(9);
        note.commands.setTextSelection(5);
        typeInto(note, '!');
        await act(async () => session.current?.close());
        const second = 26;
        expect(a.state.doc.nodeAt(second)?.attrs['id']).toBe('n2');
        await open(second);
        const offline = new Y.Doc();
        Y.applyUpdate(offline, Y.encodeStateAsUpdate(yA));
        const peer = bodyOn(offline);
        const node = peer.state.doc.nodeAt(second);
        if (!node) throw new Error('no note');
        peer.view.dispatch(peer.state.tr.delete(second, second + node.nodeSize).insert(4, node));
        peer.view.dispatch(peer.state.tr.insertText('Peer ', 6));
        await act(async () => {
            Y.applyUpdate(yA, Y.encodeStateAsUpdate(offline, Y.encodeStateVector(yA)), 'reconnect');
            await Promise.resolve();
        });
        expect(note.state.doc.textContent).toBe('Peer Note!');
        expect(noteOf(a)).toBe('Peer Note!');
    });

    test('keeps a note open that had no id, as it takes one when it opens', async () => {
        const { a, b, note, session, open, hold, release } = await setup(moved(null));
        await open(9);
        expect(session.current?.anchor?.id).toEqual(expect.any(String));
        expect(b.state.doc.nodeAt(9)?.attrs['id']).toBe(session.current?.anchor?.id);
        hold();
        await act(async () => {
            cutAndPaste(b);
            note.commands.setTextSelection(5);
            typeInto(note, '!');
        });
        await release();
        expect(session.current?.anchor?.pos).toBe(4);
        expect(noteOf(a)).toBe('Note!');
    });

    // A peer offline makes the move and types into the note, and its reconnect brings both as one update. This tab typed
    // nothing, so the open note takes the peer's text and puts nothing of its own back.
    test("takes a peer's text that came with the move, when this tab typed nothing", async () => {
        const { a, b, yA, note, session, open } = await setup(moved('n1'));
        await open(9);
        const offline = new Y.Doc();
        Y.applyUpdate(offline, Y.encodeStateAsUpdate(yA));
        const peer = bodyOn(offline);
        cutAndPaste(peer);
        peer.view.dispatch(peer.state.tr.insertText('Peer ', 6));
        await act(async () => {
            Y.applyUpdate(yA, Y.encodeStateAsUpdate(offline, Y.encodeStateVector(yA)), 'reconnect');
            await Promise.resolve();
        });
        expect(session.current?.anchor?.pos).toBe(4);
        expect(note.state.doc.textContent).toBe('Peer Note');
        expect(noteOf(a)).toBe('Peer Note');
        expect(noteOf(b)).toBe('Peer Note');
    });
});

// One undo step that typed into the open note and moved its reference, in either order: ⌘Z takes back both, and ⇧⌘Z
// brings back both.
describe('⌘Z of one step that edited the open note and moved its reference', () => {
    const steps = [
        ['typed, then moved', (type: () => void, move: () => void) => [type, move]],
        ['moved, then typed', (type: () => void, move: () => void) => [move, type]],
    ] as const;
    test.each(steps)('%s, puts the note back as it was', async (_, order) => {
        const { a, note, undoManager, open } = await setup([
            paragraph(text('One')),
            paragraph(text('Two'), { ...footnote(paragraph(text('Note'))), attrs: { id: 'n1' } }, text('.')),
        ]);
        await open(9);
        const type = () => {
            note.commands.setTextSelection(5);
            typeInto(note, '!');
        };
        const move = () => {
            const node = a.state.doc.nodeAt(9);
            if (!node) throw new Error('no note');
            a.view.dispatch(a.state.tr.delete(9, 9 + node.nodeSize).insert(4, node));
        };
        for (const step of order(type, move))
            await act(async () => {
                step();
                await Promise.resolve();
            });
        expect(noteOf(a)).toBe('Note!');
        expect(undoManager.undoStack.length).toBe(1);
        await act(async () => {
            press(note, 'z');
            await Promise.resolve();
        });
        expect(a.state.doc.nodeAt(9)?.type.name).toBe('footnote');
        expect(noteOf(a)).toBe('Note');
        expect(note.state.doc.textContent).toBe('Note');
        await act(async () => {
            press(note, 'z', true);
            await Promise.resolve();
        });
        expect(a.state.doc.nodeAt(4)?.type.name).toBe('footnote');
        expect(noteOf(a)).toBe('Note!');
    });
});

// The note's keystroke is in its editor already: the body's change it makes pulls nothing back.
test('a keystroke in the open note makes one transaction in its editor', async () => {
    const { a, note, open } = await setup();
    await open(6);
    note.commands.setTextSelection(12);
    let transactions = 0;
    note.on('transaction', () => transactions++);
    typeInto(note, '!');
    expect(noteOf(a)).toBe('Hello world!');
    expect(transactions).toBe(1);
});
