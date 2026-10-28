// A text box in the editor: a closed box draws its paragraphs and the caret never enters it; a press on its text opens
// it in place in the box's live editor, a press on its edge selects it, and Esc leaves it. Its edits forward into the
// body as one undo step, the body's changes pull back, and the body's formatting never reaches its text. Two Y.Docs
// synced by hand stand in for two tabs.
import { afterEach, expect, spyOn, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { act, createElement, useMemo } = await import('react');
const { Editor, EditorContent } = await import('@tiptap/react');
const { yUndoPluginKey } = await import('@tiptap/y-tiptap');
const { docEditorOptions } = await import('../../../../components/docs/doc-editor');
const { createDocUndoManager } = await import('../../../../components/docs/page-setup');
const { TextBoxContext } = await import('../../../../components/docs/extensions/text-box');
const { useOpenStory } = await import('../../../../components/docs/hooks/use-open-story');
const { drawsStory } = await import('../../../../components/docs/extensions/story');

type TestEditor = InstanceType<typeof Editor>;
type Target = Parameters<typeof docEditorOptions>[0]['target'];
type Session = ReturnType<typeof useOpenStory>;

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

function mount(
    doc: InstanceType<typeof Y.Doc>,
    target: Target,
    onOpen: (pos: number, at: { left: number; top: number } | null) => void = () => {},
): TestEditor {
    const editor: TestEditor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        ...docEditorOptions({
            yDoc: doc,
            editable: true,
            target,
            caret: null,
            coarsePointer: false,
            textBox: { onOpen },
            media: () => media,
            editor: () => editor,
        }),
    });
    cleanups.push(() => editor.destroy());
    return editor;
}

const text = (t: string, marks?: JSONContent['marks']): JSONContent => ({
    type: 'text',
    text: t,
    ...(marks && { marks }),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const box = (layout = 'block', ...content: JSONContent[]): JSONContent => ({
    type: 'textBox',
    attrs: { id: 'box-1', layout, offsetX: 10, offsetY: 10 },
    content: content.length > 0 ? content : [paragraph(text('Inside'))],
});
const footnote = (...content: JSONContent[]): JSONContent => ({ type: 'footnote', attrs: { id: 'n-1' }, content });

// "Anchor" 1..7, the box at 7 holding "Inside" (9..15), then ". More".
const DOC = [paragraph(text('Anchor'), box(), text('. More'))];
const BOX = 7;

// Tab A's body drawn with the box's node view, its story editors and the hook; tab B a plain body on a synced doc.
async function setup(content: JSONContent[] = DOC) {
    const yA = new Y.Doc();
    const yB = new Y.Doc();
    yA.on('update', (update: Uint8Array, origin: unknown) => origin !== 'peer' && Y.applyUpdate(yB, update, 'peer'));
    yB.on('update', (update: Uint8Array, origin: unknown) => origin !== 'peer' && Y.applyUpdate(yA, update, 'peer'));
    const session: { current: Session | null } = { current: null };
    const openAt = (pos: number, at: { left: number; top: number } | null) =>
        session.current?.open(pos, { focus: true, at, selection: null });
    const a = mount(yA, { undoManager: createDocUndoManager(yA), cardIds: () => new Set() }, openAt);
    const b = mount(yB, { undoManager: createDocUndoManager(yB), cardIds: () => new Set() });
    a.commands.setContent({ type: 'doc', content });
    const undoManager = yUndoPluginKey.getState(a.state)?.undoManager;
    if (!undoManager) throw new Error('no undo manager');
    undoManager.clear();
    const leaving = { current: () => {} };
    const note = mount(yA, { body: () => a, onLeave: () => leaving.current(), story: 'footnote' });
    const boxEditor = mount(yA, { body: () => a, onLeave: () => leaving.current(), story: 'textBox' });
    const editors = { footnote: note, textBox: boxEditor };
    function Host() {
        const current = useOpenStory(a, editors, true);
        session.current = current;
        leaving.current = current.leave;
        const anchor = current.anchor?.type === 'textBox' ? current.anchor : null;
        const value = useMemo(() => ({ anchor, editor: boxEditor }), [anchor]);
        return createElement(TextBoxContext.Provider, { value }, createElement(EditorContent, { editor: a }));
    }
    const rendered = await renderInDocument(createElement(Host));
    cleanups.push(rendered.unmount);
    return { a, b, yA, note, boxEditor, undoManager, session };
}

// The box's span in tab A, laid out as 200 by 100 at (100, 100), so a press can land inside it or on its edge band.
function laidOutBox(editor: TestEditor): HTMLElement {
    const span = editor.view.dom.querySelector<HTMLElement>('.text-box');
    const content = span?.parentElement;
    if (!span || !content) throw new Error('no box drawn');
    content.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 100, width: 200, height: 100 });
    return span;
}

const pressAt = (target: Element, x: number, y: number) =>
    act(async () => {
        target.dispatchEvent(
            new PointerEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }),
        );
    });

const boxText = (editor: TestEditor) => {
    let found = '';
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'textBox') found = node.textContent;
        return node.type.name !== 'textBox';
    });
    return found;
};

const typeInto = (editor: TestEditor, chars: string) => {
    for (const char of chars) editor.view.dispatch(editor.state.tr.insertText(char));
};

// prosemirror-keymap reads the platform once, maybe before happy-dom's, so ⌘ or Ctrl, whichever it takes as Mod.
const press = (editor: TestEditor, key: string) =>
    act(async () => {
        for (const meta of [true, false]) {
            const event = new KeyboardEvent('keydown', {
                key,
                metaKey: meta && key !== 'Escape' && key !== 'Enter',
                ctrlKey: !meta && key !== 'Escape' && key !== 'Enter',
                bubbles: true,
                cancelable: true,
            });
            editor.view.dom.dispatchEvent(event);
            if (event.defaultPrevented) return;
        }
    });

async function opened() {
    const context = await setup();
    await pressAt(laidOutBox(context.a), 150, 150);
    return context;
}

test('a closed box draws its paragraphs, and the caret never enters it', async () => {
    const { a } = await setup();
    expect(laidOutBox(a).textContent).toBe('Inside');
    expect(a.view.dom.querySelector('.text-box .ProseMirror')).toBeNull();
    await act(async () => {
        a.commands.setTextSelection(BOX);
    });
    // ProseMirror's own arrow handling reads the key code.
    await act(async () => {
        a.view.dom.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, bubbles: true, cancelable: true }),
        );
    });
    expect(a.state.selection.toJSON()).toEqual({ type: 'node', anchor: BOX });
});

test('a press on its text opens it in place in the box’s editor, with the box’s text', async () => {
    const { a, boxEditor, session } = await opened();
    expect(session.current?.anchor).toMatchObject({ type: 'textBox', id: 'box-1', pos: BOX });
    const box = laidOutBox(a);
    expect(box.querySelector('[data-story-editor] .ProseMirror')).toBe(boxEditor.view.dom);
    expect(boxEditor.state.doc.textContent).toBe('Inside');
    // The box keeps its look while open.
    expect(box.getAttribute('data-type')).toBe('text-box');
});

test('a press on its edge band opens nothing', async () => {
    const { a, session } = await setup([paragraph(box('front'), text('Anchor'))]);
    await pressAt(laidOutBox(a), 102, 150);
    expect(session.current?.anchor).toBeNull();
    expect(a.state.selection.toJSON()).toEqual({ type: 'node', anchor: 1 });
});

test('a box with less padding than the edge band keeps the band off its text', async () => {
    const tight = { ...box('front'), attrs: { id: 'box-1', layout: 'front', paddingX: 0, paddingY: 2 } };
    const { a, session } = await setup([paragraph(tight, text('Anchor'))]);
    // On its text, 2 px in from the left edge.
    await pressAt(laidOutBox(a), 102, 150);
    expect(session.current?.anchor).toMatchObject({ type: 'textBox', pos: 1 });
    await act(async () => session.current?.close());
    // In its 2 px padding along the top.
    await pressAt(laidOutBox(a), 150, 101);
    expect(session.current?.anchor).toBeNull();
    expect(a.state.selection.toJSON()).toEqual({ type: 'node', anchor: 1 });
});

// A box with no padding and no outline has no edge band, so a drag from inside a selected one moves it, as in Google
// Docs; a click there still opens it.
test('a drag inside a selected box moves it, and a click inside it opens it', async () => {
    const bare = {
        ...box('front'),
        attrs: { id: 'box-1', layout: 'front', offsetX: 10, offsetY: 10, paddingX: 0, paddingY: 0 },
    };
    const { a, session } = await setup([paragraph(bare, text('Anchor'))]);
    await act(async () => {
        a.commands.setNodeSelection(1);
    });
    laidOutBox(a);
    const chrome = a.view.dom.querySelector('[data-figure-chrome]');
    if (!chrome) throw new Error('no chrome');
    const pointer = (type: string, x: number, y: number) =>
        act(async () => {
            const event = new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, button: 0, bubbles: true });
            (type === 'pointerdown' ? chrome : document).dispatchEvent(event);
        });
    await pointer('pointerdown', 150, 150);
    await pointer('pointermove', 180, 170);
    await pointer('pointerup', 180, 170);
    expect(session.current?.anchor).toBeNull();
    expect(a.state.doc.nodeAt(1)?.attrs).toMatchObject({ offsetX: 40, offsetY: 30 });

    await pointer('pointerdown', 150, 150);
    expect(session.current?.anchor).toBeNull();
    // A hand's jitter is no drag.
    await pointer('pointermove', 151, 151);
    await pointer('pointerup', 151, 151);
    expect(session.current?.anchor).toMatchObject({ type: 'textBox', pos: 1 });
    expect(a.state.doc.nodeAt(1)?.attrs).toMatchObject({ offsetX: 40, offsetY: 30 });
});

// The paragraph's box lies over a behind box, so a press there lands on the text's layer, never in the box's editor.
test('a drag and a double-click in an open behind box select its text', async () => {
    const { a, boxEditor, session } = await setup([paragraph(box('behind'), text('Anchor'))]);
    await act(async () => session.current?.open(1, { focus: true, at: null, selection: null }));
    const anchor = session.current?.anchor;
    const paragraphDom = a.view.nodeDOM(0);
    const frame = a.view.dom.querySelector('.figure[data-layout="behind"]');
    if (!(paragraphDom instanceof HTMLElement) || !frame) throw new Error('not drawn');
    const restore = { points: document.elementsFromPoint, rects: Range.prototype.getClientRects };
    cleanups.push(() => {
        document.elementsFromPoint = restore.points;
        Range.prototype.getClientRects = restore.rects;
    });
    document.elementsFromPoint = () => [paragraphDom, a.view.dom, frame];
    // The anchor's one line of text lies above the press.
    const line = DOMRect.fromRect({ x: 0, y: 0, width: 50, height: 20 });
    Range.prototype.getClientRects = () => ({
        0: line,
        length: 1,
        item: (index: number) => (index === 0 ? line : null),
        [Symbol.iterator]: () => [line][Symbol.iterator](),
    });
    spyOn(boxEditor.view, 'posAtCoords').mockImplementation(({ left }) => ({ pos: left / 50, inside: -1 }));
    const mouse = (type: string, target: EventTarget, clientX: number, { detail = 1, buttons = 1 } = {}) =>
        act(async () => {
            target.dispatchEvent(
                new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    button: 0,
                    buttons,
                    clientX,
                    clientY: 150,
                    detail,
                }),
            );
        });
    await mouse('mousedown', paragraphDom, 100);
    await mouse('mousemove', document, 250);
    await mouse('mouseup', document, 250);
    expect(session.current?.anchor).toBe(anchor);
    expect(boxEditor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 2, head: 5 });
    await mouse('mousedown', paragraphDom, 150, { detail: 2 });
    expect(boxEditor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 1, head: 7 });

    // A button let go outside the window sends this page no mouseup: the next move, with no button down, ends the drag.
    await mouse('mousedown', paragraphDom, 100);
    await mouse('mousemove', document, 250, { buttons: 0 });
    await mouse('mousemove', document, 300);
    expect(boxEditor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 2, head: 2 });
    // One let go over the window's edge reaches the window alone.
    await mouse('mousedown', paragraphDom, 100);
    await mouse('mouseup', window, 100);
    await mouse('mousemove', document, 300);
    expect(boxEditor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 2, head: 2 });
});

test('typing in the open box forwards as one undo step, and ⌘Z in the box takes it back', async () => {
    const { a, b, boxEditor, undoManager } = await opened();
    await act(async () => {
        boxEditor.commands.setTextSelection(7);
        typeInto(boxEditor, ' text');
    });
    expect(boxText(a)).toBe('Inside text');
    expect(boxText(b)).toBe('Inside text');
    undoManager.stopCapturing();
    await press(boxEditor, 'z');
    expect(boxText(a)).toBe('Inside');
    expect(boxEditor.state.doc.textContent).toBe('Inside');
});

// A keystroke changes the box's node, never its look: the box redraws nothing and measures nothing for it.
test('typing in the open box leaves the look of its span as it was', async () => {
    const { a, boxEditor } = await opened();
    const span = laidOutBox(a);
    const written = spyOn(span, 'setAttribute');
    await act(async () => {
        boxEditor.commands.setTextSelection(7);
        typeInto(boxEditor, ' text');
    });
    expect(boxText(a)).toBe('Inside text');
    expect(written).not.toHaveBeenCalled();
});

test("a peer's edit to the box pulls into the open editor, and a peer's delete hands the caret to the body", async () => {
    const { a, b, boxEditor, session } = await opened();
    await act(async () => {
        b.view.dispatch(b.state.tr.insertText('Peer ', BOX + 2));
    });
    expect(boxEditor.state.doc.textContent).toBe('Peer Inside');
    await act(async () => {
        const node = b.state.doc.nodeAt(BOX);
        b.view.dispatch(b.state.tr.delete(BOX, BOX + (node?.nodeSize ?? 0)));
    });
    expect(session.current?.anchor).toBeNull();
    expect(a.view.dom.querySelector('.text-box')).toBeNull();
});

// A peer offline moves the box to the first paragraph and types into it, and its reconnect brings both as one update.
// This tab typed nothing, so the open box takes the peer's text and puts nothing of its own back.
test("a peer's move and edit of the open box, as one update after a reconnect, reach the open editor", async () => {
    const { a, b, yA, boxEditor, session } = await setup([paragraph(text('One')), ...DOC]);
    await act(async () => session.current?.open(5 + BOX, { focus: true, at: null, selection: null }));
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(yA));
    const peer = mount(offline, { undoManager: createDocUndoManager(offline), cardIds: () => new Set() });
    const node = peer.state.doc.nodeAt(5 + BOX);
    if (!node) throw new Error('no box');
    peer.view.dispatch(peer.state.tr.delete(5 + BOX, 5 + BOX + node.nodeSize).insert(1, node));
    peer.view.dispatch(peer.state.tr.insertText('Peer ', 3));
    await act(async () => {
        Y.applyUpdate(yA, Y.encodeStateAsUpdate(offline, Y.encodeStateVector(yA)), 'reconnect');
        await Promise.resolve();
    });
    expect(session.current?.anchor?.pos).toBe(1);
    expect(boxEditor.state.doc.textContent).toBe('Peer Inside');
    expect(boxText(a)).toBe('Peer Inside');
    expect(boxText(b)).toBe('Peer Inside');
});

test("a press on the box's comment mark opens no box, as the mark is a button of its own", async () => {
    const commented = { ...box(), attrs: { id: 'box-1', layout: 'block', commentCardId: 'card-1' } };
    const { a, session } = await setup([paragraph(text('Anchor'), commented, text('. More'))]);
    laidOutBox(a);
    const mark = a.view.dom.querySelector('button[aria-label="Open comment"]');
    if (!mark) throw new Error('no comment mark');
    await pressAt(mark, 150, 150);
    expect(session.current?.anchor).toBeNull();
});

// The find bar's reveal selects the match in the body, which opens the story holding it.
test('a box without an id, as a web page pastes one, takes one as a body selection inside it opens it', async () => {
    const { a, boxEditor, session } = await setup([paragraph(text('Anchor'), { ...box(), attrs: { id: null } })]);
    await act(async () => {
        a.commands.setTextSelection({ from: BOX + 2, to: BOX + 5 });
    });
    expect(session.current?.anchor?.id).toEqual(expect.any(String));
    expect(a.state.doc.nodeAt(BOX)?.attrs['id']).toBe(session.current?.anchor?.id);
    expect(a.view.nodeDOM(BOX)?.contains(boxEditor.view.dom)).toBe(true);
    expect(boxEditor.state.doc.textBetween(boxEditor.state.selection.from, boxEditor.state.selection.to)).toBe('Ins');
});

// A peer's paste of an earlier copy and an undo of the original's delete can leave two boxes with one id.
const boxTexts = (editor: TestEditor) => {
    const texts: string[] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'textBox') texts.push(node.textContent);
        return node.type.name !== 'textBox';
    });
    return texts;
};

test('the open box found again by an id two boxes hold closes, and neither copy takes its text', async () => {
    const { a, boxEditor, session } = await opened();
    await act(async () => {
        boxEditor.commands.setTextSelection(7);
        typeInto(boxEditor, ' typed');
    });
    await act(async () => {
        const node = a.state.doc.nodeAt(BOX);
        if (!node) throw new Error('no box');
        const copy = () => a.schema.nodeFromJSON(box('block', paragraph(text('Copy'))));
        const tr = a.state.tr.delete(BOX, BOX + node.nodeSize);
        tr.insert(tr.doc.content.size - 1, [copy(), copy()]);
        a.view.dispatch(tr);
        await Promise.resolve();
    });
    expect(session.current?.anchor).toBeNull();
    expect(boxTexts(a)).toEqual(['Copy', 'Copy']);
});

test("only the open box's own node draws its editor when a peer's copy holds its id", async () => {
    const { a, b, boxEditor, session } = await opened();
    const editorsIn = () => [...a.view.dom.querySelectorAll('[data-story-editor]')];
    await act(async () => {
        const copy = b.schema.nodeFromJSON(box('block', paragraph(text('Copy'))));
        b.view.dispatch(b.state.tr.insert(b.state.doc.content.size - 1, copy));
    });
    expect(boxTexts(a)).toEqual(['Inside', 'Copy']);
    expect(editorsIn()).toHaveLength(1);
    expect(a.view.nodeDOM(BOX)?.contains(boxEditor.view.dom)).toBe(true);
    // Typing here changes the box's node, which draws before the binding maps the box's element to it.
    await act(async () => {
        boxEditor.commands.setTextSelection(7);
        typeInto(boxEditor, '!');
    });
    expect(boxTexts(a)).toEqual(['Inside!', 'Copy']);
    expect(editorsIn()).toHaveLength(1);
    // A peer's edit in the box and before both moves it, and its node view draws before the anchor follows.
    await act(async () => {
        b.view.dispatch(b.state.tr.insertText('Peer ', BOX + 2).insertText('Pre ', 1));
    });
    expect(session.current?.anchor).toMatchObject({ type: 'textBox', pos: BOX + 4 });
    expect(boxTexts(a)).toEqual(['Peer Inside!', 'Copy']);
    expect(editorsIn()).toHaveLength(1);
    expect(a.view.nodeDOM(BOX + 4)?.contains(boxEditor.view.dom)).toBe(true);
    // A peer's split of the anchor paragraph draws the box in a new view, before the anchor follows.
    await act(async () => {
        b.view.dispatch(b.state.tr.split(3));
    });
    expect(session.current?.anchor).toMatchObject({ type: 'textBox', pos: BOX + 6 });
    expect(editorsIn()).toHaveLength(1);
    expect(a.view.nodeDOM(BOX + 6)?.contains(boxEditor.view.dom)).toBe(true);
});

// The open box asks on every render whether it draws the editor, and the doc is walked for its id once per change.
test('the open box looks for copies of its id once per doc', async () => {
    const { a, session } = await opened();
    const anchor = session.current?.anchor;
    const node = a.state.doc.nodeAt(BOX);
    if (!anchor || !node) throw new Error('not open');
    const walk = spyOn(a.state.doc, 'descendants');
    for (let render = 0; render < 3; render++) expect(drawsStory(a, anchor, node)).toBe(true);
    expect(walk.mock.calls.length).toBeLessThanOrEqual(1);
});

test('Esc leaves the box selected, and a second Esc puts the caret after it', async () => {
    const { a, boxEditor, session } = await opened();
    await press(boxEditor, 'Escape');
    expect(session.current?.anchor).toBeNull();
    expect(a.state.selection.toJSON()).toEqual({ type: 'node', anchor: BOX });
    await press(a, 'Escape');
    expect(a.state.selection.toJSON()).toEqual({ type: 'text', anchor: BOX + 10, head: BOX + 10 });
});

test('Enter on a selected box opens it', async () => {
    const { a, session } = await setup();
    await act(async () => {
        a.commands.setNodeSelection(BOX);
    });
    await press(a, 'Enter');
    expect(session.current?.anchor).toMatchObject({ type: 'textBox', pos: BOX });
});

test("bold across the anchor paragraph leaves the box's text as it was", async () => {
    const { a } = await setup();
    await act(async () => {
        a.commands.selectAll();
        a.commands.toggleBold();
    });
    let marked = false;
    a.state.doc.descendants((node, _pos, parent) => {
        if (parent?.type.name === 'paragraph' && node.isText && node.text === 'Inside') marked = node.marks.length > 0;
    });
    expect(marked).toBe(false);
});

test('opening a box closes an open note, and opening the note closes the box', async () => {
    const { a, session } = await setup([paragraph(text('Anchor'), box(), text('.'), footnote(paragraph(text('N'))))]);
    let notePos = -1;
    a.state.doc.descendants((node, pos) => {
        if (node.type.name === 'footnote') notePos = pos;
    });
    await act(async () => session.current?.open(notePos, { focus: true, at: null, selection: null }));
    expect(session.current?.anchor?.type).toBe('footnote');
    await pressAt(laidOutBox(a), 150, 150);
    expect(session.current?.anchor?.type).toBe('textBox');
    await act(async () => session.current?.open(notePos, { focus: true, at: null, selection: null }));
    expect(session.current?.anchor?.type).toBe('footnote');
    expect(a.view.dom.querySelector('.text-box [data-story-editor]')).toBeNull();
});

test('a remount of the open box, as a re-anchor makes, keeps it open with the focus in its editor', async () => {
    const { a, boxEditor, session } = await setup([...DOC, paragraph(text('Next'))]);
    await pressAt(laidOutBox(a), 150, 150);
    await act(async () => {
        boxEditor.commands.focus('end');
    });
    await act(async () => {
        // The browser drops the focus of the editor the remount takes away; happy-dom keeps it.
        boxEditor.view.dom.blur();
        const node = a.state.doc.nodeAt(BOX);
        if (!node) throw new Error('no box');
        // A delete and an insert of the node at the start of the next paragraph.
        const tr = a.state.tr.delete(BOX, BOX + node.nodeSize);
        tr.insert((tr.doc.firstChild?.nodeSize ?? 0) + 1, node);
        a.view.dispatch(tr);
    });
    expect(session.current?.anchor).toMatchObject({ type: 'textBox', pos: 15 });
    expect(laidOutBox(a).querySelector('.ProseMirror')).toBe(boxEditor.view.dom);
    expect(document.activeElement).toBe(boxEditor.view.dom);
});

// TipTap hands a drag inside a node view to ProseMirror, which would drag the whole box out of its paragraph.
test('a text drag inside the open box starts no drag of the box', async () => {
    const { a, boxEditor } = await opened();
    const inner = boxEditor.view.dom.querySelector('p');
    if (!inner) throw new Error('no paragraph');
    await act(async () => {
        boxEditor.commands.setTextSelection({ from: 1, to: 4 });
        a.commands.setNodeSelection(BOX);
        inner.dispatchEvent(
            new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }),
        );
    });
    expect(a.view.dragging).toBeNull();
});

test('a pasted copy of a box takes a fresh id, and a cut and paste keeps its own', async () => {
    const { a } = await setup();
    const html = a.getHTML();
    await act(async () => {
        a.commands.setTextSelection(a.state.doc.content.size - 1);
        a.view.pasteHTML(html);
    });
    const ids: unknown[] = [];
    a.state.doc.descendants((node) => {
        if (node.type.name === 'textBox') ids.push(node.attrs['id']);
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('box-1');
    expect(ids[1]).not.toBe('box-1');
    expect(typeof ids[1]).toBe('string');

    await act(async () => {
        a.commands.setContent({ type: 'doc', content: [paragraph(text('Empty'))] });
        a.view.pasteHTML(html);
    });
    const kept: unknown[] = [];
    a.state.doc.descendants((node) => {
        if (node.type.name === 'textBox') kept.push(node.attrs['id']);
    });
    expect(kept).toEqual(['box-1']);
});

test('Insert › Text box puts an open, empty box in the flow after the caret', async () => {
    const { a, session } = await setup([paragraph(text('Anchor'))]);
    const { insertTextBox } = await import('@workspace/lib/docs/eigendoc');
    const inserted: (number | null)[] = [];
    await act(async () => {
        a.commands.setTextSelection(7);
        const { tr } = a.state;
        const pos = insertTextBox(tr);
        inserted.push(pos);
        a.view.dispatch(tr);
        if (pos !== null) session.current?.open(pos, { focus: true, at: null, selection: null });
    });
    expect(inserted).toEqual([7]);
    expect(session.current?.anchor).toMatchObject({ type: 'textBox', pos: 7 });
    expect(a.state.doc.nodeAt(7)?.attrs).toMatchObject({ layout: 'block', alignment: 'left' });
});

// Every ResizeObserver built from here on, told that what it watches resized as `resized()` is called.
function observeResizes(): () => Promise<void> {
    const observers: (() => void)[] = [];
    const Observer = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
        public constructor(callback: ResizeObserverCallback) {
            observers.push(() => callback([], this));
        }
        public observe() {}
        public unobserve() {}
        public disconnect() {}
    };
    cleanups.push(() => {
        globalThis.ResizeObserver = Observer;
    });
    return () =>
        act(async () => {
            for (const observe of observers) observe();
        });
}

// The box's span drawn as tall as its min-height, or as its text, which wraps to 140 px once it is narrower than 200 px
// and is 100 px otherwise.
function drawnAsLaidOut(editor: TestEditor) {
    const span = editor.view.dom.querySelector<HTMLElement>('.text-box');
    if (!span) throw new Error('no box drawn');
    Object.defineProperty(span, 'offsetHeight', {
        configurable: true,
        get: () =>
            Math.max(
                Number.parseFloat(span.style.minHeight) || 0,
                Number.parseFloat(span.style.width) < 200 ? 140 : 100,
            ),
    });
}

// ObjectTransform's grips listen on the document once pressed; happy-dom has no pointer capture.
async function dragGrip(editor: TestEditor, position: string, dx: number, dy: number) {
    const grip = [...editor.view.dom.querySelectorAll<HTMLElement>('.eigen-selection-handle')].find((element) =>
        position.split(' ').every((name) => element.classList.contains(name)),
    );
    if (!grip) throw new Error(`no ${position} grip`);
    grip.setPointerCapture = () => {};
    const at = (type: string, x: number, y: number, target: EventTarget) =>
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
    await act(async () => {
        at('pointerdown', 0, 0, grip);
    });
    await act(async () => {
        at('pointermove', dx, dy, document);
    });
    await act(async () => {
        at('pointerup', dx, dy, document);
    });
}

test("the bottom grip writes the box's height, and a narrower width keeps an auto box auto", async () => {
    const resized = observeResizes();
    const { a } = await setup();
    await act(async () => {
        a.commands.setNodeSelection(BOX);
        a.commands.updateTextBox({ width: 220 });
    });
    drawnAsLaidOut(a);
    await resized();
    await dragGrip(a, 'top-1/2 -right-2.5', -40, 0);
    expect(a.state.doc.nodeAt(BOX)?.attrs).toMatchObject({ width: 180, height: null });
    await resized();
    await dragGrip(a, '-bottom-2.5 left-1/2', 0, 50);
    expect(a.state.doc.nodeAt(BOX)?.attrs).toMatchObject({ width: 180, height: 190 });
});

// An auto box is as tall as its text, which only its drawn box knows, and it changes after the render a write causes, or
// with no write at all as an image in it loads.
test("the Text box panel's height follows the box as drawn", async () => {
    const resized = observeResizes();
    const { a } = await setup();
    await act(async () => {
        a.commands.setNodeSelection(BOX);
    });
    const { TextBoxPropertiesPanel } = await import('../../../../components/docs/text-box-properties-panel');
    const { mmToPx } = await import('@workspace/lib/docs/eigendoc');
    const panel = await renderInDocument(createElement(TextBoxPropertiesPanel, { editor: a }));
    cleanups.push(panel.unmount);
    Object.defineProperty(laidOutBox(a), 'offsetHeight', { configurable: true, value: mmToPx(40) });
    await resized();
    const [, height] = document.querySelectorAll<HTMLInputElement>('input[type="number"][step="0.01"]');
    expect(height?.value).toBe('4.00');
});

// The positioned figures measure a box by its view's frame, as they measure an image, to keep it in place on a switch
// to in front of the text and on a drag.
test("the box's view holds the frame alone, its content box first inside it", async () => {
    const { a } = await setup();
    const dom = a.view.nodeDOM(BOX);
    const frame = dom instanceof Element ? dom.firstElementChild : null;
    expect(frame?.classList.contains('figure')).toBe(true);
    expect(frame?.firstElementChild?.firstElementChild?.classList.contains('text-box')).toBe(true);
    expect(dom instanceof Element ? dom.querySelector('[data-node-view-content-react]') : 'none').toBeNull();
});
