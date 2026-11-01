// The table of contents as the editor draws it: the body's headings to the node's level, each in its level's look,
// following every edit, a collaborator's too. A press selects it, and a mod-press on an entry jumps to the heading.
import { afterEach, expect, spyOn, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { isMacOS } from '@tiptap/core';
import { NodeSelection, Plugin } from '@tiptap/pm/state';
import { getFontFamily } from '@workspace/lib/constants/fonts';
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
// Each right-click's editor and the position of the table of contents it was on.
const menus: [InstanceType<typeof Editor>, number][] = [];

function body(doc = new Y.Doc(), editable = true) {
    const editor: InstanceType<typeof Editor> = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        ...docEditorOptions({
            yDoc: doc,
            editable,
            target: { undoManager: createDocUndoManager(doc), cardIds: () => new Set() },
            caret: null,
            coarsePointer: false,
            tableOfContents: {
                onJump: (pos) => jumps.push(pos),
                onContextMenu: (target, pos) => menus.push([target, pos]),
            },
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
const toc = (levels = 3, attrs: Record<string, unknown> = {}): JSONContent => ({
    type: 'tableOfContents',
    attrs: { levels, ...attrs },
});

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

// The key a click holds to act on a node rather than the text, as ProseMirror reads it: command on a Mac, where control
// and a click is the right-click, else control.
const MOD = isMacOS() ? 'metaKey' : 'ctrlKey';
const OTHER = isMacOS() ? 'ctrlKey' : 'metaKey';

const press = (keys: MouseEventInit = {}) => new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...keys });

// The heading the press jumped to, or null for none.
function jumpedTo(editor: InstanceType<typeof Editor>, target: Element | null | undefined, event: MouseEvent) {
    jumps.length = 0;
    target?.dispatchEvent(event);
    const pos = jumps.at(0);
    return pos === undefined ? null : (editor.state.doc.nodeAt(pos)?.textContent ?? null);
}

test('a mod-press on an entry jumps to its heading, counted past the deeper headings it leaves out', () => {
    const editor = body();
    editor.commands.setContent({
        type: 'doc',
        content: [toc(1), heading(2, 'Deep'), heading(1, 'Intro')],
    });
    const line = nav(editor)?.querySelector('[data-level="1"]');
    expect(jumpedTo(editor, line, press({ [MOD]: true }))).toBe('Intro');
    expect(jumpedTo(editor, line, press({ [OTHER]: true }))).toBeNull();
    expect(jumpedTo(editor, line, press())).toBeNull();
});

// ProseMirror's own press handling selects the node on the release. After a jump that put the caret in the heading, it
// would select the table of contents, and the next key typed would replace it. Its mousedown handler is what watches
// for that release.
test('ProseMirror takes a plain press on an entry and beside the entries, and leaves a mod-press to the entry', () => {
    const editor = body();
    editor.commands.setContent({ type: 'doc', content: [toc(), heading(1, 'Intro')] });
    // The tag of each press ProseMirror handles.
    const seen: string[] = [];
    const mousedown = (_: unknown, event: MouseEvent) => {
        seen.push(event.target instanceof Element ? event.target.tagName : '');
        return false;
    };
    // Ahead of the editor's own plugins, as one of them takes a press on the node.
    editor.registerPlugin(new Plugin({ props: { handleDOMEvents: { mousedown } } }), (plugin, plugins) => [
        plugin,
        ...plugins,
    ]);
    const line = nav(editor)?.querySelector('[data-level]');
    line?.dispatchEvent(press({ [MOD]: true }));
    expect(seen).toEqual([]);
    line?.dispatchEvent(press());
    nav(editor)?.dispatchEvent(press());
    expect(seen).toEqual(['A', 'NAV']);
});

// happy-dom lays nothing out, so the press lands on the table of contents at 0, with no figure under it.
test('a plain press on an entry selects the table of contents and jumps nowhere', () => {
    const editor = body();
    editor.commands.setContent({ type: 'doc', content: [toc(), heading(1, 'Intro')] });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const hit = spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 0, inside: 0 });
    const points = document.elementsFromPoint;
    document.elementsFromPoint = () => [];
    const line = nav(editor)?.querySelector('[data-level]');
    expect(jumpedTo(editor, line, press())).toBeNull();
    line?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    hit.mockRestore();
    document.elementsFromPoint = points;
    const { selection } = editor.state;
    expect(selection instanceof NodeSelection && [selection.from, selection.node.type.name]).toEqual([
        0,
        'tableOfContents',
    ]);
});

// A viewer has no panel to open, so a press follows the entry, as a link in a read-only editor does.
test("a viewer's plain press on an entry jumps", () => {
    const doc = new Y.Doc();
    const writer = body(doc);
    writer.commands.setContent({ type: 'doc', content: [toc(), heading(1, 'Intro')] });
    const viewer = body(doc, false);
    expect(jumpedTo(viewer, nav(viewer)?.querySelector('[data-level]'), press())).toBe('Intro');
});

// A finger holds no key: its first tap selects the table of contents, and a tap on an entry of the selected one jumps.
test('a tap on an entry of the selected table of contents jumps, and one on another does not', () => {
    const editor = body();
    editor.commands.setContent({ type: 'doc', content: [toc(), heading(1, 'Intro')] });
    const line = nav(editor)?.querySelector('[data-level]');
    const tap = () => {
        line?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
        return press();
    };
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(jumpedTo(editor, line, tap())).toBeNull();
    editor.commands.setNodeSelection(0);
    expect(jumpedTo(editor, line, tap())).toBe('Intro');
    // A mouse after the finger presses as a mouse does.
    line?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    expect(jumpedTo(editor, line, press())).toBeNull();
});

test('a right-click hands the editor and the position of the table of contents to the menu', () => {
    const editor = body();
    editor.commands.setContent({ type: 'doc', content: [heading(1, 'Intro'), toc()] });
    menus.length = 0;
    nav(editor)
        ?.querySelector('[data-level]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(menus).toEqual([[editor, editor.state.doc.child(0).nodeSize]]);
});

// The look of each entry the editor draws: its font, size, weight and style, inline.
const looks = (editor: InstanceType<typeof Editor>) =>
    [...(nav(editor)?.querySelectorAll<HTMLElement>('[data-level]') ?? [])].map(({ style }) => [
        style.fontFamily,
        style.fontSize,
        style.fontWeight,
        style.fontStyle,
    ]);

test("each entry draws its level's look, and a level with none draws as the body text", () => {
    const editor = body();
    editor.commands.setContent({
        type: 'doc',
        content: [
            toc(3, { level1: { font: 'Source Serif 4', size: 14, bold: true }, level3: { italic: true, bold: false } }),
            heading(1, 'Intro'),
            heading(2, 'Method'),
            heading(3, 'Detail'),
        ],
    });
    // The family as an element writes it back, with the quotes it uses.
    const { style } = document.createElement('a');
    style.fontFamily = getFontFamily('Source Serif 4');
    expect(looks(editor)).toEqual([
        [style.fontFamily, '14pt', 'bold', ''],
        ['', '', '', ''],
        ['', '', '', 'italic'],
    ]);
});

// eigen-prose.css draws the entries of one at "links" as links, and of every one on a page-less doc, whose page sets
// data-pageless.
test('names its layout for the stylesheet, Links when it shows no page numbers', () => {
    const editor = body();
    editor.commands.setContent({ type: 'doc', content: [toc(3, { pageNumbers: false }), heading(1, 'Intro')] });
    expect(nav(editor)?.getAttribute('data-preset')).toBe('links');
    editor.commands.setContent({ type: 'doc', content: [toc(3, { leader: 'none' }), heading(1, 'Intro')] });
    expect(nav(editor)?.getAttribute('data-preset')).toBe('plain');
});

test('draws again as its layout or a level changes, and keeps its lines through an edit elsewhere', () => {
    const editor = body();
    editor.commands.setContent({ type: 'doc', content: [toc(), heading(1, 'Intro'), paragraph('Text')] });
    editor.commands.setNodeSelection(0);
    editor.commands.updateTableOfContents({ pageNumbers: false, level1: { size: 20 } });
    expect(nav(editor)?.getAttribute('data-preset')).toBe('links');
    expect(looks(editor)).toEqual([['', '20pt', '', '']]);
    editor.commands.updateTableOfContents({ level1: null });
    expect(looks(editor)).toEqual([['', '', '', '']]);
    const [line] = nav(editor)?.children ?? [];
    editor.commands.insertContentAt(endOf(editor, 'Text'), ' more');
    expect(nav(editor)?.children[0]).toBe(line);
});

// A paste can put one in a quote or a list item, and the PDF and the docx list the headings wherever it is.
test('one inside another block lists the headings too', () => {
    const editor = body();
    editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'blockquote', content: [toc()] }, heading(1, 'Intro')],
    });
    expect(entries(editor)).toEqual([['1', 'Intro']]);
});
