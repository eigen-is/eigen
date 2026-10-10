import { describe, expect, test } from 'bun:test';
import {
    type Content,
    createDocument,
    Editor,
    generateHTML,
    getSchema,
    type JSONContent,
    type SingleCommands,
} from '@tiptap/core';
import { GapCursor } from '@tiptap/pm/gapcursor';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { getDocExtensions } from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// prosemirror-keymap resolved Mod from bun's navigator when the imports above loaded it; happy-dom's says Linux.
const MOD_ENTER: KeyboardEventInit = {
    key: 'Enter',
    ...(/Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
};

// generateHTML serializes through `document`, createDocument parses with DOMParser, the editor mounts in the window.
installHappyDom();

// lowlight is the apps' dependency, not lib's: a highlighter that finds nothing still gives the schema its code block.
const lowlight = {
    highlight: () => ({ children: [] }),
    highlightAuto: () => ({ children: [] }),
    listLanguages: () => [],
};
const extensions = getDocExtensions({ lowlight });
const schema = getSchema(extensions);

const brokenDoc: JSONContent = {
    type: 'doc',
    content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
        { type: 'pageBreak' },
        { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
    ],
};

const blockTypes = (doc: ProseMirrorNode): string[] => doc.children.map((node) => node.type.name);

// Through the view's key handling, as a browser presses it: tiptap's keyboardShortcut command re-applies the
// captured steps and throws on the paragraph this insert appends.
function press(editor: Editor, key: KeyboardEventInit): boolean {
    const event = new KeyboardEvent('keydown', key);
    return !!editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, event));
}

const mount = (content: Content, editorExtensions = extensions): Editor =>
    new Editor({ element: document.createElement('div'), extensions: editorExtensions, content });

const figure: JSONContent = { type: 'figure', attrs: { mediaName: 'a.png' } };
const table = '<table><tbody><tr><td><p>A</p></td><td><p>B</p></td></tr></tbody></table>';

describe('page break HTML', () => {
    // The HTML and PDF exports page at exactly this class.
    test('a page break renders as a div with the exact page-break class', () => {
        expect(generateHTML(brokenDoc, extensions)).toContain(
            '<p>Before</p><div class="page-break"></div><p>After</p>',
        );
    });

    test('an empty page-break div parses as a page break', () => {
        expect(blockTypes(createDocument('<p>Before</p><div class="page-break"></div><p>After</p>', schema))).toEqual([
            'paragraph',
            'pageBreak',
            'paragraph',
        ]);
    });

    // Only an empty div is a page break: any other element carrying the class keeps its content.
    test.each([
        ['<h2 class="page-break">Heading</h2>', ['heading']],
        ['<h2 class="page-break"></h2>', ['heading']],
        ['<div class="page-break">Text</div>', ['paragraph']],
        ['<table class="page-break"><tbody><tr><td><p>Cell</p></td></tr></tbody></table>', ['table']],
        ['<ul><li class="page-break"><p>Item</p></li></ul>', ['bulletList']],
        ['<p><span class="page-break">Text</span></p>', ['paragraph']],
    ])('%s keeps its content', (html, types) => {
        const doc = createDocument(html, schema);
        expect(blockTypes(doc)).toEqual(types);
        expect(doc.textContent).toBe(html.replace(/<[^>]+>/g, ''));
    });

    test.each(['<hr>', '<hr class="page-break">'])('%s stays a horizontal rule', (html) => {
        expect(blockTypes(createDocument(`<p>Before</p>${html}<p>After</p>`, schema))).toEqual([
            'paragraph',
            'horizontalRule',
            'paragraph',
        ]);
    });

    test('a page break survives the HTML round-trip', () => {
        expect(createDocument(generateHTML(brokenDoc, extensions), schema).toJSON()).toEqual(
            schema.nodeFromJSON(brokenDoc).toJSON(),
        );
    });
});

describe('page break keys', () => {
    // The page break listed first proves its priority, not its place in the list, beats StarterKit's hard break.
    test.each([
        ['after', extensions],
        [
            'before',
            [
                ...extensions.filter(({ name }) => name === 'pageBreak'),
                ...extensions.filter(({ name }) => name !== 'pageBreak'),
            ],
        ],
    ])('Mod-Enter in a paragraph inserts a page break, listed %s StarterKit', (_order, editorExtensions) => {
        const editor = mount('<p>Before</p>', editorExtensions);
        editor.commands.setTextSelection(7);
        press(editor, MOD_ENTER);
        expect(blockTypes(editor.state.doc)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
        // The caret waits in the paragraph appended after the break.
        expect(editor.state.selection.from).toBe(10);
        editor.destroy();
    });

    test.each([
        ['in the middle of', 4, ['paragraph', 'pageBreak', 'paragraph'], 'ore'],
        ['at the start of', 1, ['pageBreak', 'paragraph'], 'Before'],
    ])(
        'Mod-Enter %s a paragraph leaves the caret at the start of the text after the break',
        (_where, pos, types, after) => {
            const editor = mount('<p>Before</p>');
            editor.commands.setTextSelection(pos);
            press(editor, MOD_ENTER);
            const { selection, doc } = editor.state;
            expect(blockTypes(doc)).toEqual(types);
            expect(selection).toBeInstanceOf(TextSelection);
            expect(selection.$from.parent.textContent).toBe(after);
            expect(selection.$from.parentOffset).toBe(0);
            editor.destroy();
        },
    );

    test('Mod-Enter in a code block exits it', () => {
        const editor = mount('<pre><code>let a</code></pre><p>After</p>');
        editor.commands.setTextSelection(6);
        press(editor, MOD_ENTER);
        expect(blockTypes(editor.state.doc)).toEqual(['codeBlock', 'paragraph', 'paragraph']);
        expect(editor.state.selection.$from.parent.textContent).toBe('');
        editor.destroy();
    });

    test('Shift-Enter is still a hard break', () => {
        const editor = mount('<p>Before</p>');
        editor.commands.setTextSelection(4);
        press(editor, { key: 'Enter', shiftKey: true });
        expect(editor.getJSON().content?.[0]?.content?.map((node) => node.type)).toEqual(['text', 'hardBreak', 'text']);
        editor.destroy();
    });

    test.each([
        ['alone in its paragraph', [figure], 1, [['figure'], undefined]],
        [
            'mid-paragraph',
            [{ type: 'text', text: 'A' }, figure, { type: 'text', text: 'B' }],
            2,
            [['text', 'figure'], ['text']],
        ],
    ])('Mod-Enter on a selected figure %s breaks the paragraph after it', (_where, inline, figurePos, halves) => {
        const editor = mount({ type: 'doc', content: [{ type: 'paragraph', content: inline }] });
        editor.commands.setNodeSelection(figurePos);
        press(editor, MOD_ENTER);
        expect(blockTypes(editor.state.doc)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
        const [before, , after] = editor.getJSON().content ?? [];
        expect([before?.content?.map((node) => node.type), after?.content?.map((node) => node.type)]).toEqual(halves);
        // The caret waits at the start of the half after the break.
        const { selection } = editor.state;
        expect(selection).toBeInstanceOf(TextSelection);
        expect([selection.$from.index(0), selection.$from.parentOffset]).toEqual([2, 0]);
        editor.destroy();
    });

    test('a selected figure can take a page break', () => {
        const editor = mount({ type: 'doc', content: [{ type: 'paragraph', content: [figure] }] });
        editor.commands.setNodeSelection(1);
        expect(editor.can().setPageBreak()).toBe(true);
        editor.destroy();
    });

    // A gap cursor needs a closed block on both sides; a list opens on a paragraph.
    test('Mod-Enter just before a list puts the caret in its first item', () => {
        const editor = mount('<p>Before</p><ul><li><p>Item</p></li></ul><p>After</p>');
        editor.commands.setTextSelection(7);
        press(editor, MOD_ENTER);
        expect(blockTypes(editor.state.doc)).toEqual(['paragraph', 'pageBreak', 'bulletList', 'paragraph']);
        expect(editor.state.selection).toBeInstanceOf(TextSelection);
        editor.commands.insertContent('x');
        expect(editor.state.doc.child(2).textContent).toBe('xItem');
        editor.destroy();
    });

    // A node selection on the table would turn into a cell selection of all of it, which one Backspace deletes.
    test.each([
        ['a table', table, 'table'],
        ['a horizontal rule', '<hr>', 'horizontalRule'],
    ])(
        'Mod-Enter just before %s leaves a gap cursor, and Backspace removes the break, not the block',
        (_block, html, type) => {
            const editor = mount(`<p>Before</p><p></p>${html}<p>After</p>`);
            editor.commands.setTextSelection(9);
            press(editor, MOD_ENTER);
            expect(blockTypes(editor.state.doc)).toEqual(['paragraph', 'pageBreak', type, 'paragraph']);
            expect(editor.state.selection).toBeInstanceOf(GapCursor);
            // The first press selects the break, the second deletes it.
            press(editor, { key: 'Backspace' });
            press(editor, { key: 'Backspace' });
            expect(blockTypes(editor.state.doc)).toEqual(['paragraph', type, 'paragraph']);
            editor.destroy();
        },
    );

    // Where no page break fits, HardBreak's Mod-Enter would empty a cell or replace the selected node.
    test.each([
        [
            'selected cells',
            `<p>Before</p>${table}`,
            (commands: SingleCommands) => commands.setCellSelection({ anchorCell: 10, headCell: 15 }),
        ],
        [
            'a selected list item',
            '<ul><li><p>A</p></li><li><p>B</p></li></ul>',
            (commands: SingleCommands) => commands.setNodeSelection(1),
        ],
    ])('Mod-Enter on %s is swallowed and leaves the document as it is', (_selection, html, select) => {
        const editor = mount(html);
        select(editor.commands);
        const before = editor.getJSON();
        expect(editor.can().setPageBreak()).toBe(false);
        expect(press(editor, MOD_ENTER)).toBe(true);
        expect(editor.getJSON()).toEqual(before);
        editor.destroy();
    });
});
