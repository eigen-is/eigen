import { describe, expect, test } from 'bun:test';
import type { Content, JSONContent } from '@tiptap/core';
import { createDocument, Editor, generateHTML, getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { getDocExtensions, readTocLevels } from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// generateHTML serializes through `document`, createDocument parses with DOMParser, the editor mounts in the window.
installHappyDom();

const extensions = getDocExtensions();
const schema = getSchema(extensions);

const blockTypes = (doc: ProseMirrorNode): string[] => doc.children.map((node) => node.type.name);

const mount = (content: Content): Editor => new Editor({ element: document.createElement('div'), extensions, content });

const tocDoc = (levels: unknown): JSONContent => ({
    type: 'doc',
    content: [{ type: 'tableOfContents', attrs: { levels } }, { type: 'paragraph' }],
});

describe('table of contents HTML', () => {
    test('renders as a nav carrying its levels, and parses back from it', () => {
        const html = generateHTML(tocDoc(2), extensions);
        expect(html).toContain('<nav data-type="table-of-contents" data-levels="2"></nav>');
        const doc = createDocument(html, schema);
        expect(blockTypes(doc)).toEqual(['tableOfContents', 'paragraph']);
        expect(doc.child(0).attrs['levels']).toBe(2);
    });

    // The export writes its entries inside the nav, so a download pasted back is the node again, entries derived.
    test('a nav holding entries parses as the node, and one without levels lists three', () => {
        const doc = createDocument(
            '<nav data-type="table-of-contents"><a href="#h-1">Intro</a></nav><p>After</p>',
            schema,
        );
        expect(blockTypes(doc)).toEqual(['tableOfContents', 'paragraph']);
        expect(doc.child(0).attrs['levels']).toBe(3);
        expect(doc.textContent).toBe('After');
    });

    test('a nav of any other page stays its links', () => {
        const doc = createDocument('<nav><a href="#intro">Intro</a></nav>', schema);
        expect(blockTypes(doc)).toEqual(['paragraph']);
        expect(doc.textContent).toBe('Intro');
    });
});

describe('readTocLevels', () => {
    test.each([
        [1, 1],
        [6, 6],
        [0, 1],
        [7, 6],
        [2.6, 3],
        ['x', 3],
        [null, 3],
        [Number.NaN, 3],
    ])('reads %p as %p', (value, levels) => {
        expect(readTocLevels(value)).toBe(levels);
    });

    test('renders a stored level a peer wrote out of range at the clamped one', () => {
        expect(generateHTML(tocDoc(9), extensions)).toContain('data-levels="6"');
    });
});

describe('insertTableOfContents', () => {
    test('splits a paragraph, and the caret lands at the start of its second half, in one step', () => {
        const editor = mount('<p>Before</p>');
        editor.commands.setTextSelection(4);
        expect(editor.commands.insertTableOfContents()).toBe(true);
        const { doc, selection } = editor.state;
        expect(blockTypes(doc)).toEqual(['paragraph', 'tableOfContents', 'paragraph']);
        expect(selection).toBeInstanceOf(TextSelection);
        expect(selection.$from.parent.textContent).toBe('ore');
        expect(selection.$from.parentOffset).toBe(0);
        editor.destroy();
    });

    test('at the end of the doc it opens a paragraph after itself for the caret', () => {
        const editor = mount('<p>Before</p>');
        editor.commands.setTextSelection(7);
        editor.commands.insertTableOfContents();
        expect(blockTypes(editor.state.doc)).toEqual(['paragraph', 'tableOfContents', 'paragraph']);
        expect(editor.state.selection.from).toBe(10);
        editor.destroy();
    });

    test.each([
        ['a table cell', '<table><tbody><tr><td><p>Cell</p></td></tr></tbody></table>', 4],
        ['a list item', '<ul><li><p>Item</p></li></ul>', 4],
        ['a quote', '<blockquote><p>Said</p></blockquote>', 3],
    ])('refuses in %s, which only the body holds it beside', (_where, html, pos) => {
        const editor = mount(html);
        editor.commands.setTextSelection(pos);
        const before = editor.getJSON();
        expect(editor.can().insertTableOfContents()).toBe(false);
        expect(editor.commands.insertTableOfContents()).toBe(false);
        expect(editor.getJSON()).toEqual(before);
        editor.destroy();
    });

    test('a selected table of contents is one Backspace from deleted', () => {
        const editor = mount(tocDoc(3));
        editor.commands.setNodeSelection(0);
        editor.commands.deleteSelection();
        expect(blockTypes(editor.state.doc)).toEqual(['paragraph']);
        editor.destroy();
    });
});
