import { describe, expect, test } from 'bun:test';
import { createDocument, Editor, generateHTML, getSchema, type JSONContent } from '@tiptap/core';
import { getDocExtensions, PageBreakNode } from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// prosemirror-keymap resolved Mod from bun's navigator when the imports above loaded it; happy-dom's says Linux.
const MOD: KeyboardEventInit = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

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

const blockTypes = (html: string): string[] => {
    const types: string[] = [];
    createDocument(html, schema).forEach((node) => {
        types.push(node.type.name);
    });
    return types;
};

// Through the view's key handling, as a browser presses it: tiptap's keyboardShortcut command re-applies the
// captured steps and throws on the paragraph this insert appends.
function pressInEditor(html: string, caret: number, key: KeyboardEventInit, editorExtensions = extensions): Editor {
    const editor = new Editor({ element: document.createElement('div'), extensions: editorExtensions, content: html });
    editor.commands.setTextSelection(caret);
    const event = new KeyboardEvent('keydown', { key: 'Enter', ...key });
    editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, event));
    return editor;
}

describe('page break HTML', () => {
    // html-to-docx turns exactly this class into a Word page break.
    test('a page break renders as a div with the exact page-break class', () => {
        expect(generateHTML(brokenDoc, extensions)).toContain(
            '<p>Before</p><div class="page-break" data-type="page-break"></div><p>After</p>',
        );
    });

    test.each([
        '<div class="page-break" data-type="page-break"></div>',
        // The docx import's carrier.
        '<hr class="page-break">',
    ])('%s parses as a page break', (html) => {
        expect(blockTypes(`<p>Before</p>${html}<p>After</p>`)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
    });

    test('a plain hr stays a horizontal rule', () => {
        expect(blockTypes('<p>Before</p><hr><p>After</p>')).toEqual(['paragraph', 'horizontalRule', 'paragraph']);
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
        ['before', [PageBreakNode, ...extensions.filter((extension) => extension.name !== 'pageBreak')]],
    ])('Mod-Enter in a paragraph inserts a page break, listed %s StarterKit', (_order, editorExtensions) => {
        const editor = pressInEditor('<p>Before</p>', 7, MOD, editorExtensions);
        expect(editor.getJSON().content?.map((node) => node.type)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
        // The caret waits in the paragraph appended after the break.
        expect(editor.state.selection.from).toBe(10);
        editor.destroy();
    });

    test('Mod-Enter in a code block exits it', () => {
        const editor = pressInEditor('<pre><code>let a</code></pre><p>After</p>', 6, MOD);
        expect(editor.getJSON().content?.map((node) => node.type)).toEqual(['codeBlock', 'paragraph', 'paragraph']);
        expect(editor.state.selection.$from.parent.textContent).toBe('');
        editor.destroy();
    });

    test('Shift-Enter is still a hard break', () => {
        const editor = pressInEditor('<p>Before</p>', 4, { shiftKey: true });
        expect(editor.getJSON().content?.[0]?.content?.map((node) => node.type)).toEqual(['text', 'hardBreak', 'text']);
        editor.destroy();
    });
});
