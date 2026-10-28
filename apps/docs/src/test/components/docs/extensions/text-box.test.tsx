// A text box in the editor: a closed box draws its paragraphs and the caret never enters it; a press on its text opens
// it in place in the box's live editor, a press on its edge selects it, and Esc leaves it. Its edits forward into the
// body as one undo step, the body's changes pull back, and the body's formatting never reaches its text. Two Y.Docs
// synced by hand stand in for two tabs.
import { afterEach, expect, test } from 'bun:test';
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
    return { a, b, note, boxEditor, undoManager, session };
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

test("a press on the box's comment mark opens no box, as the mark is a button of its own", async () => {
    const commented = { ...box(), attrs: { id: 'box-1', layout: 'block', commentCardId: 'card-1' } };
    const { a, session } = await setup([paragraph(text('Anchor'), commented, text('. More'))]);
    laidOutBox(a);
    const mark = a.view.dom.querySelector('button[aria-label="Open comment"]');
    if (!mark) throw new Error('no comment mark');
    await pressAt(mark, 150, 150);
    expect(session.current?.anchor).toBeNull();
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
