import { afterAll, describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { createDocument, generateHTML, getSchema } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { JSDOM } from 'jsdom';
import {
    BAND_EXCLUDED_NODES,
    BLOCK_ONLY_FIGURE_PARENTS,
    FIGURE_FRAME_NODES,
    flattenNestedStories,
    getDocExtensions,
    insertTextBox,
    isFigureFrameNode,
    isStoryNode,
    MAX_PAPER_MM,
    mmToPx,
    readTextBoxAttrs,
    TEXT_BOX_DEFAULT_WIDTH,
    TEXT_BOX_PARAGRAPH,
    TEXT_BOX_SELECTOR,
} from '../../../../docs/eigendoc';

// jsdom's, a spec HTML parser: a pasted box must survive the one a browser runs, where a <p> in a <p> closes it.
const { window } = new JSDOM();
const previous = { window: globalThis.window, document: globalThis.document, DOMParser: globalThis.DOMParser };
Object.assign(globalThis, { window, document: window.document, DOMParser: window.DOMParser });
afterAll(() => {
    Object.assign(globalThis, previous);
});

const extensions = getDocExtensions();
const schema = getSchema(extensions);

const text = (value: string, marks?: JSONContent['marks']): JSONContent => ({
    type: 'text',
    text: value,
    ...(marks && { marks }),
});
const paragraph = (...content: JSONContent[]): JSONContent => ({
    type: 'paragraph',
    ...(content.length > 0 && { content }),
});
const box = (attrs: Record<string, unknown>, ...paragraphs: JSONContent[]): JSONContent => ({
    type: 'textBox',
    attrs,
    content: paragraphs,
});
const footnote = (...paragraphs: JSONContent[]): JSONContent => ({ type: 'footnote', content: paragraphs });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

const BOLD = [{ type: 'bold' }];

const parse = (html: string): JSONContent => createDocument(html, schema).toJSON();
const stored = (content: JSONContent) => Node.fromJSON(schema, content).toJSON();
const roundTrip = (content: JSONContent) => parse(generateHTML(content, extensions));

const LOOK = {
    id: 'box-1',
    width: 300,
    height: 120,
    fill: '#ffeeaa',
    outline: '2px dashed #c00000',
    paddingX: 12,
    paddingY: 6,
    verticalAlign: 'middle',
    rounded: true,
};

// An aligned, formatted paragraph with a bold run and an inline picture, then a plain one.
const CONTENT = [
    {
        type: 'paragraph',
        attrs: { textAlign: 'center', lineSpacing: 1.5 },
        content: [text('Bold', BOLD), text(' and '), { type: 'figure', attrs: { mediaName: 'a.png', width: 40 } }],
    },
    paragraph(text('second')),
];

describe('the text box node', () => {
    test('is an inline atom holding paragraphs, isolating and selectable, in the frame and a story', () => {
        const type = schema.nodes['textBox'];
        expect(type?.isInline).toBe(true);
        expect(type?.isAtom).toBe(true);
        expect(type?.spec.content).toBe('paragraph+');
        expect(type?.spec.isolating).toBe(true);
        expect(type?.spec.selectable).toBe(true);
        expect(FIGURE_FRAME_NODES).toContain('textBox');
        expect(isFigureFrameNode('textBox')).toBe(true);
        expect(isStoryNode('textBox')).toBe(true);
        expect(isStoryNode('footnote')).toBe(true);
        expect(isStoryNode('figure')).toBe(false);
        // A positioned picture inside a box draws in line.
        expect(BLOCK_ONLY_FIGURE_PARENTS).toContain('textBox');
    });

    test("a band's schema has none", () => {
        expect(BAND_EXCLUDED_NODES.has('textBox')).toBe(true);
        expect(getSchema(getDocExtensions({ exclude: [...BAND_EXCLUDED_NODES] })).nodes['textBox']).toBeUndefined();
    });
});

describe('text box HTML', () => {
    test('the frame span holds the box span, its look as data attributes and a style, and a span per paragraph', () => {
        const html = generateHTML(
            doc(paragraph(text('a'), box({ ...LOOK, layout: 'front', offsetX: 30, offsetY: -4 }, ...CONTENT))),
            extensions,
        );
        expect(html).toContain('<span class="figure" data-layout="front" data-offset-x="30" data-offset-y="-4">');
        expect(html).toContain(
            '<span class="text-box" data-type="text-box" data-story-id="box-1" data-width="300" data-height="120" data-fill="#ffeeaa" data-outline="2px dashed #c00000" data-padding-x="12" data-padding-y="6" data-vertical-align="middle" data-rounded="" style="width: 300px; min-height: 120px; background-color: #ffeeaa; border: 2px dashed #c00000; padding: 6px 12px; border-radius: 8px">',
        );
        // The paragraph's own rendered attributes ride on its span; a <p> would close the body's paragraph.
        expect(html).toMatch(
            new RegExp(`<span style="[^"]*text-align: center[^"]*"[^>]*data-type="${TEXT_BOX_PARAGRAPH}"`),
        );
        expect(html).not.toContain('<p style');
    });

    test('parses back to the same box: every layout, the look, the id, the paragraphs with their format', () => {
        for (const layout of ['block', 'wrap-left', 'wrap-right', 'front', 'behind']) {
            const placed = layout === 'front' || layout === 'behind' ? { offsetX: 12, offsetY: 8 } : {};
            const content = doc(
                paragraph(text('a'), box({ ...LOOK, layout, alignment: 'right', ...placed }, ...CONTENT)),
            );
            expect(roundTrip(content)).toEqual(stored(content));
        }
    });

    test('a box with the defaults keeps them: auto height, no fill, no outline, Word’s insets', () => {
        const content = doc(paragraph(box({}, paragraph(text('x')))));
        expect(roundTrip(content)).toEqual(stored(content));
        const html = generateHTML(content, extensions);
        expect(html).toContain(`style="width: ${TEXT_BOX_DEFAULT_WIDTH}px; padding: 4.8px 9.6px"`);
    });

    test('a box pasted inside a box, or a note inside a box, keeps its text flattened into the outer box', () => {
        const nested = doc(
            paragraph(
                box(
                    { id: 'outer' },
                    paragraph(text('outer'), box({ id: 'inner' }, paragraph(text('inner')), paragraph(text('two')))),
                    paragraph(text('end'), footnote(paragraph(text('note')))),
                ),
            ),
        );
        const html = generateHTML(flattenNestedStories(nested), extensions);
        expect(parse(html)).toEqual(
            stored(
                doc(paragraph(box({ id: 'outer' }, paragraph(text('outer inner two')), paragraph(text('end note'))))),
            ),
        );
        // A forged nested box in stored HTML parses flattened too.
        const forged = `<p><span class="figure" data-layout="block"><span class="text-box" data-type="text-box"><span data-type="${TEXT_BOX_PARAGRAPH}">a<span class="figure" data-layout="front"><span class="text-box" data-type="text-box"><span data-type="${TEXT_BOX_PARAGRAPH}">b</span></span></span></span></span></span></p>`;
        expect(parse(forged)).toEqual(stored(doc(paragraph(box({}, paragraph(text('a b')))))));
    });

    test('a box in a note flattens, as a note in a note does', () => {
        const forged = doc(paragraph(footnote(paragraph(text('n'), box({}, paragraph(text('boxed')))))));
        expect(stored(flattenNestedStories(forged))).toEqual(
            stored(doc(paragraph(footnote(paragraph(text('n boxed')))))),
        );
    });

    // Another app's absolute box or a Word HTML frame is no Eigen box: its text pastes as paragraphs.
    test('another app’s absolute <div> pastes as its paragraphs', () => {
        const pasted = parse(
            '<div style="position: absolute; left: 40px; top: 10px; width: 200px; border: 1px solid #000"><p>One</p><p>Two</p></div>',
        );
        expect(pasted).toEqual(stored(doc(paragraph(text('One')), paragraph(text('Two')))));
        expect(parse('<p>a<span class="text-box">b</span></p>')).toEqual(stored(doc(paragraph(text('ab')))));
    });
});

describe('readTextBoxAttrs', () => {
    test('a forged value reads as the default or clamped', () => {
        const forged = readTextBoxAttrs({
            id: 42,
            width: 0,
            height: Number.NaN,
            fill: 'red',
            outline: '1e9px solid #000',
            paddingX: -3,
            paddingY: 1e6,
            verticalAlign: 'sideways',
            rounded: 'yes',
        });
        expect(forged).toMatchObject({
            id: null,
            width: 24,
            height: null,
            fill: null,
            outline: null,
            paddingX: 0,
            paddingY: 96,
            verticalAlign: null,
            rounded: false,
        });
        expect(readTextBoxAttrs({ width: 1e9 }).width).toBe(mmToPx(MAX_PAPER_MM));
        expect(readTextBoxAttrs({ width: '300' }).width).toBe(TEXT_BOX_DEFAULT_WIDTH);
        expect(readTextBoxAttrs({ outline: 'none' }).outline).toBe('none');
    });

    test('a forged look in pasted HTML reads the same way', () => {
        const html = `<p><span class="figure" data-layout="block"><span class="text-box" data-type="text-box" data-story-id="a b" data-width="0" data-fill="red" data-outline="9px solid #000000" data-vertical-align="up"><span data-type="${TEXT_BOX_PARAGRAPH}">x</span></span></span></p>`;
        const node = Node.fromJSON(schema, parse(html)).firstChild?.firstChild;
        expect(node?.type.name).toBe('textBox');
        expect(node?.attrs).toMatchObject({ id: null, width: 24, fill: null, outline: null, verticalAlign: null });
    });
});

describe('insertTextBox', () => {
    const stateOf = (content: JSONContent, at: number, s = schema) => {
        const node = Node.fromJSON(s, content);
        return EditorState.create({ doc: node, selection: TextSelection.create(node, at) });
    };

    test('inserts a block box after the caret, left aligned, 6 cm wide, white with a black outline, with an id', () => {
        const { tr } = stateOf(doc(paragraph(text('ab'))), 2);
        expect(insertTextBox(tr)).toBe(2);
        const inserted = tr.doc.nodeAt(2);
        expect(inserted?.type.name).toBe('textBox');
        expect(inserted?.attrs).toMatchObject({
            layout: 'block',
            alignment: 'left',
            width: TEXT_BOX_DEFAULT_WIDTH,
            height: null,
            fill: '#ffffff',
            outline: '1px solid #000000',
        });
        expect(typeof inserted?.attrs['id']).toBe('string');
        expect(inserted?.childCount).toBe(1);
    });

    test('refuses inside a story and where the schema has none', () => {
        const inNote = stateOf(doc(paragraph(text('a'), footnote(paragraph(text('note'))))), 5);
        expect(insertTextBox(inNote.tr)).toBeNull();
        const inBox = stateOf(doc(paragraph(text('a'), box({}, paragraph(text('box'))))), 5);
        expect(insertTextBox(inBox.tr)).toBeNull();
        const band = getSchema(getDocExtensions({ exclude: [...BAND_EXCLUDED_NODES] }));
        expect(insertTextBox(stateOf(doc(paragraph(text('a'))), 1, band).tr)).toBeNull();
    });

    test('its selector names the box span only', () => {
        expect(TEXT_BOX_SELECTOR).toBe('span[data-type="text-box"]');
    });
});
