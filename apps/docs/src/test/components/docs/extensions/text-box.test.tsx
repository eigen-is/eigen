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
        const openId = current.anchor?.type === 'textBox' ? current.anchor.id : null;
        const value = useMemo(() => ({ openId, editor: boxEditor }), [openId]);
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
