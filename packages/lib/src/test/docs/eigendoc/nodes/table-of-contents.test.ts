import { describe, expect, test } from 'bun:test';
import type { Content, JSONContent } from '@tiptap/core';
import { createDocument, Editor, generateHTML, getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { getFontFamily, MAX_FONT_SIZE } from '../../../../constants/fonts';
import type { TocLevelStyle, TocPreset } from '../../../../docs/eigendoc';
import {
    getDocExtensions,
    readTocLayout,
    readTocLevelStyle,
    readTocLevels,
    TOC_LEVEL_KEYS,
    TOC_PRESETS,
    tocLevelCss,
    tocPreset,
} from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// generateHTML serializes through `document`, createDocument parses with DOMParser, the editor mounts in the window.
installHappyDom();

const extensions = getDocExtensions();
const schema = getSchema(extensions);

const blockTypes = (doc: ProseMirrorNode): string[] => doc.children.map((node) => node.type.name);

const mount = (content: Content): Editor => new Editor({ element: document.createElement('div'), extensions, content });

const tocDoc = (levels: unknown, attrs: Record<string, unknown> = {}): JSONContent => ({
    type: 'doc',
    content: [{ type: 'tableOfContents', attrs: { levels, ...attrs } }, { type: 'paragraph' }],
});

const navOf = (html: string): string => html.slice(0, html.indexOf('</nav>') + '</nav>'.length);

// The stored attributes of a fresh node, and what an untouched one keeps.
const DEFAULT_ATTRS = {
    levels: 3,
    pageNumbers: true,
    leader: 'dot',
    level1: null,
    level2: null,
    level3: null,
    level4: null,
    level5: null,
    level6: null,
};

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

describe('table of contents attributes', () => {
    test('a fresh one shows page numbers on a dotted leader, and every level draws as the body text', () => {
        const editor = mount('<p>Before</p>');
        editor.commands.setTextSelection(7);
        editor.commands.insertTableOfContents();
        expect(editor.state.doc.child(1).attrs).toEqual(DEFAULT_ATTRS);
        editor.destroy();
    });

    test('names a key for each heading level', () => {
        expect(TOC_LEVEL_KEYS).toEqual(['level1', 'level2', 'level3', 'level4', 'level5', 'level6']);
    });

    test('an untouched one renders the nav it always did', () => {
        expect(navOf(generateHTML(tocDoc(3), extensions))).toBe(
            '<nav data-type="table-of-contents" data-levels="3"></nav>',
        );
        expect(navOf(generateHTML(tocDoc(3, DEFAULT_ATTRS), extensions))).toBe(
            '<nav data-type="table-of-contents" data-levels="3"></nav>',
        );
    });

    test('renders every attribute apart from its default, and parses each back', () => {
        const attrs = {
            levels: 4,
            pageNumbers: false,
            leader: 'none',
            level1: { bold: true },
            level3: { font: 'Source Serif 4', size: 14, italic: true },
            level6: { bold: false },
        };
        const html = generateHTML(tocDoc(4, attrs), extensions);
        const nav = navOf(html);
        expect(nav).toContain('data-page-numbers="false"');
        expect(nav).toContain('data-leader="none"');
        expect(nav).toContain('data-level1="{&quot;bold&quot;:true}"');
        expect(nav).not.toContain('data-level2');
        const doc = createDocument(html, schema);
        expect(doc.child(0).attrs).toEqual({ ...DEFAULT_ATTRS, ...attrs });
    });

    test('a pasted nav keeps only what the readers allow', () => {
        const doc = createDocument(
            `<nav data-type="table-of-contents" data-page-numbers="no" data-leader="dash"
                data-level1='{"font":"Comic Sans","size":"x","script":1}' data-level2='{"size":12'
                data-level3='{"size":10.24,"bold":"yes"}'></nav>`,
            schema,
        );
        expect(doc.child(0).attrs).toEqual({ ...DEFAULT_ATTRS, level3: { size: 10 } });
    });

    // A pasted level is read only up to 256 characters. JSON allows the trailing spaces that make it long.
    test.each([
        [256, { bold: true }],
        [257, null],
    ])('a pasted level %p characters long reads as %p', (length, level1) => {
        const json = '{"bold":true}'.padEnd(length);
        const doc = createDocument(`<nav data-type="table-of-contents" data-level1='${json}'></nav>`, schema);
        expect(doc.child(0).attrs['level1']).toEqual(level1);
    });

    test('renders a peer’s stored value as its reader reads it', () => {
        const nav = navOf(
            generateHTML(tocDoc(3, { pageNumbers: 'false', leader: 'dash', level2: { size: 900, x: 1 } }), extensions),
        );
        expect(nav).toBe(
            `<nav data-type="table-of-contents" data-levels="3" data-level2="{&quot;size&quot;:${MAX_FONT_SIZE}}"></nav>`,
        );
    });
});

describe('readTocLevelStyle', () => {
    test('keeps a bundled font, a size in pt and the two flags', () => {
        const style: TocLevelStyle = { font: 'JetBrains Mono', size: 9.5, bold: true, italic: false };
        expect(readTocLevelStyle(style)).toEqual(style);
    });

    test.each([
        ['a font not bundled, dropping it', { font: 'Arial', bold: true }, { bold: true }],
        ['a font of the wrong type, dropping it', { font: 3, italic: true }, { italic: true }],
        ['a size above the mark’s bounds, at the largest', { size: 1000 }, { size: MAX_FONT_SIZE }],
        ['a size off the half points, at the nearest', { size: 11.3 }, { size: 11.5 }],
        ['a size that is no number, dropping it', { size: '12', bold: true }, { bold: true }],
        ['an infinite size, dropping it', { size: Number.POSITIVE_INFINITY, bold: true }, { bold: true }],
        ['flags that are no booleans, dropping them', { bold: 1, italic: 'true', size: 12 }, { size: 12 }],
        ['keys it does not know, dropping them', { size: 12, color: 'red', weight: 700 }, { size: 12 }],
    ])('reads %s', (_what, value, read) => {
        expect(readTocLevelStyle(value)).toEqual(read);
    });

    test.each([
        ['null', null],
        ['an empty record', {}],
        ['nothing it keeps', { font: 'Arial', size: 'big', weight: 700 }],
        ['an array', [{ bold: true }]],
        ['a string', '{"bold":true}'],
    ])('reads %s as no style', (_what, value) => {
        expect(readTocLevelStyle(value)).toBeNull();
    });
});

describe('tocLevelCss', () => {
    test('draws each fact of a look as its mark does, bold at the weight the surface gives', () => {
        expect(tocLevelCss({ font: 'JetBrains Mono', size: 9.5, bold: true, italic: true }, '600')).toBe(
            `font-family: ${getFontFamily('JetBrains Mono')}; font-size: 9.5pt; font-weight: 600; font-style: italic`,
        );
    });

    test('draws nothing for no look, or for flags turned off', () => {
        expect(tocLevelCss(null, '600')).toBe('');
        expect(tocLevelCss({ bold: false, italic: false }, '600')).toBe('');
    });
});

describe('readTocLayout', () => {
    test('reads the two facts through their readers, defaulting to page numbers on a dotted leader', () => {
        expect(readTocLayout({})).toEqual({ pageNumbers: true, leader: 'dot' });
        expect(readTocLayout({ pageNumbers: false, leader: 'none' })).toEqual({ pageNumbers: false, leader: 'none' });
        expect(readTocLayout({ pageNumbers: 'false', leader: 'dash' })).toEqual({ pageNumbers: true, leader: 'dot' });
    });
});

describe('tocPreset', () => {
    test.each<[Record<string, unknown>, TocPreset]>([
        [{}, 'dotted'],
        [{ pageNumbers: true, leader: 'dot' }, 'dotted'],
        [{ pageNumbers: true, leader: 'none' }, 'plain'],
        [{ pageNumbers: false, leader: 'dot' }, 'links'],
        [{ pageNumbers: false, leader: 'none' }, 'links'],
        [{ pageNumbers: 'false', leader: 'dash' }, 'dotted'],
    ])('reads %p as %p on pages', (attrs, preset) => {
        expect(tocPreset(attrs, false)).toBe(preset);
    });

    test('a page-less doc draws Links whatever is stored', () => {
        expect(tocPreset({ pageNumbers: true, leader: 'dot' }, true)).toBe('links');
        expect(tocPreset({ pageNumbers: true, leader: 'none' }, true)).toBe('links');
    });

    test.each<TocPreset>(['dotted', 'plain', 'links'])('the facts of %p read back as it', (preset) => {
        const editor = mount(tocDoc(3, { pageNumbers: true, leader: preset === 'dotted' ? 'none' : 'dot' }));
        editor.commands.setNodeSelection(0);
        editor.commands.updateTableOfContents(TOC_PRESETS[preset]);
        expect(tocPreset(editor.state.doc.child(0).attrs, false)).toBe(preset);
        editor.destroy();
    });

    test('Links keeps the stored leader, so Plain text comes back after it', () => {
        const editor = mount(tocDoc(3, { leader: 'none' }));
        editor.commands.setNodeSelection(0);
        editor.commands.updateTableOfContents(TOC_PRESETS.links);
        expect(editor.state.doc.child(0).attrs['leader']).toBe('none');
        editor.destroy();
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
    // Selected, so its panel opens.
    const selectedNode = (editor: Editor): string | null => {
        const { selection } = editor.state;
        return selection instanceof NodeSelection ? selection.node.type.name : null;
    };

    test('splits a paragraph and selects the new one', () => {
        const editor = mount('<p>Before</p>');
        editor.commands.setTextSelection(4);
        expect(editor.commands.insertTableOfContents()).toBe(true);
        const { doc, selection } = editor.state;
        expect(blockTypes(doc)).toEqual(['paragraph', 'tableOfContents', 'paragraph']);
        expect(doc.textContent).toBe('Before');
        expect(selectedNode(editor)).toBe('tableOfContents');
        expect(selection.from).toBe(doc.child(0).nodeSize);
        editor.destroy();
    });

    test.each([
        ['at the start of a paragraph', '<p>Before</p>', 1, 1],
        ['at the end of the doc', '<p>Before</p>', 7, 7],
        ['in an empty paragraph', '<p></p>', 1, 1],
        ['over selected text, which it replaces', '<p>Before</p>', 2, 5],
    ])('%s it selects the new one, a paragraph after it', (_where, html, from, to) => {
        const editor = mount(html);
        editor.commands.setTextSelection({ from, to });
        editor.commands.insertTableOfContents();
        expect(selectedNode(editor)).toBe('tableOfContents');
        expect(blockTypes(editor.state.doc).at(-1)).toBe('paragraph');
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

// The panel's write: an attribute step moves no position, so the node stays selected and its panel open.
describe('updateTableOfContents', () => {
    const selected = (levels: number): Editor => {
        const editor = mount(tocDoc(levels));
        editor.commands.setNodeSelection(0);
        return editor;
    };

    test('writes the levels of the selected table of contents and keeps it selected', () => {
        const editor = selected(3);
        expect(editor.commands.updateTableOfContents({ levels: 5 })).toBe(true);
        expect(editor.state.doc.child(0).attrs['levels']).toBe(5);
        const { selection } = editor.state;
        expect(selection).toBeInstanceOf(NodeSelection);
        expect(selection instanceof NodeSelection && selection.node.type.name).toBe('tableOfContents');
        editor.destroy();
    });

    test.each([
        [0, 1],
        [9, 6],
    ])('holds %p to the heading levels, writing %p', (levels, written) => {
        const editor = selected(3);
        editor.commands.updateTableOfContents({ levels });
        expect(editor.state.doc.child(0).attrs['levels']).toBe(written);
        editor.destroy();
    });

    test('writes several attributes in one call, each through its reader, and keeps the node selected', () => {
        const editor = selected(3);
        expect(
            editor.commands.updateTableOfContents({
                levels: 9,
                pageNumbers: false,
                leader: 'none',
                level1: { bold: true },
                level2: { font: 'Inter', size: 1000 },
            }),
        ).toBe(true);
        expect(editor.state.doc.child(0).attrs).toEqual({
            ...DEFAULT_ATTRS,
            levels: 6,
            pageNumbers: false,
            leader: 'none',
            level1: { bold: true },
            level2: { font: 'Inter', size: MAX_FONT_SIZE },
        });
        const { selection } = editor.state;
        expect(selection instanceof NodeSelection && selection.node.type.name).toBe('tableOfContents');
        editor.destroy();
    });

    test('leaves what the call does not give, and null clears a level', () => {
        const editor = mount(tocDoc(2, { leader: 'none', level1: { bold: true }, level2: { italic: true } }));
        editor.commands.setNodeSelection(0);
        editor.commands.updateTableOfContents({ level1: null });
        expect(editor.state.doc.child(0).attrs).toEqual({
            ...DEFAULT_ATTRS,
            levels: 2,
            leader: 'none',
            level2: { italic: true },
        });
        editor.destroy();
    });

    test('writes one level by its key', () => {
        const editor = selected(3);
        editor.commands.updateTableOfContents({ level4: { italic: true } });
        expect(editor.state.doc.child(0).attrs['level4']).toEqual({ italic: true });
        editor.destroy();
    });

    test('names only the six heading levels', () => {
        const editor = selected(3);
        // @ts-expect-error: a heading goes no deeper than level 6.
        editor.commands.updateTableOfContents({ level9: { italic: true } });
        expect(editor.state.doc.child(0).attrs['level9']).toBeUndefined();
        editor.destroy();
    });

    test('refuses with the caret in text', () => {
        const editor = mount(tocDoc(3));
        editor.commands.setTextSelection(2);
        expect(editor.commands.updateTableOfContents({ levels: 5 })).toBe(false);
        expect(editor.state.doc.child(0).attrs['levels']).toBe(3);
        editor.destroy();
    });

    test('refuses with another node selected', () => {
        const editor = mount({
            type: 'doc',
            content: [{ type: 'tableOfContents' }, { type: 'horizontalRule' }, { type: 'paragraph' }],
        });
        editor.commands.setNodeSelection(1);
        const before = editor.getJSON();
        expect(editor.commands.updateTableOfContents({ levels: 5 })).toBe(false);
        expect(editor.getJSON()).toEqual(before);
        editor.destroy();
    });
});
