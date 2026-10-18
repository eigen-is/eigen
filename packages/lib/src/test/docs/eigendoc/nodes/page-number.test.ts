import { describe, expect, test } from 'bun:test';
import { createDocument, generateHTML, getSchema, type JSONContent } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { getDocExtensions } from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// generateHTML serializes through `document`, createDocument parses with DOMParser.
installHappyDom();

const extensions = getDocExtensions();
const schema = getSchema(extensions);

const field = (kind: unknown): JSONContent => ({ type: 'pageNumber', attrs: { kind } });
const inParagraph = (...content: JSONContent[]): JSONContent => ({
    type: 'doc',
    content: [{ type: 'paragraph', content }],
});
const kinds = (html: string) => {
    const found: unknown[] = [];
    createDocument(html, schema).descendants((node) => {
        if (node.type.name === 'pageNumber') found.push(node.attrs.kind);
    });
    return found;
};

describe('the pageNumber node', () => {
    test.each(['page', 'pages'])('a %s field renders as a span with its kind and parses back', (kind) => {
        const html = generateHTML(inParagraph(field(kind)), extensions);
        expect(html).toBe(`<p><span data-type="page-number" data-kind="${kind}">#</span></p>`);
        expect(kinds(html)).toEqual([kind]);
    });

    // A peer or a pasted page writes what it likes; the PDF and the docx must still get a field they know.
    test('any other kind reads as page, on render and on parse', () => {
        for (const forged of ['total', '', null, 3, '<b>']) {
            expect(generateHTML(inParagraph(field(forged)), extensions)).toBe(
                '<p><span data-type="page-number" data-kind="page">#</span></p>',
            );
        }
        expect(kinds('<p><span data-type="page-number" data-kind="sections">#</span></p>')).toEqual(['page']);
        expect(kinds('<p><span data-type="page-number">#</span></p>')).toEqual(['page']);
    });

    test('a span that is no field stays text', () => {
        expect(kinds('<p><span data-kind="page">#</span></p>')).toEqual([]);
    });

    // Google's Page count goes anywhere text goes.
    test('it sits wherever inline content does: a heading, a list item, a table cell', () => {
        const doc = Node.fromJSON(schema, {
            type: 'doc',
            content: [
                { type: 'heading', attrs: { level: 1 }, content: [field('page')] },
                {
                    type: 'bulletList',
                    content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [field('pages')] }] }],
                },
                {
                    type: 'table',
                    content: [
                        {
                            type: 'tableRow',
                            content: [
                                { type: 'tableCell', content: [{ type: 'paragraph', content: [field('page')] }] },
                            ],
                        },
                    ],
                },
            ],
        });
        expect(() => doc.check()).not.toThrow();
    });

    // What the chip shows: a search or a quoted anchor reads "Page # of #", and no digit a page never had.
    test('its text is the chip’s #', () => {
        const doc = Node.fromJSON(
            schema,
            inParagraph({ type: 'text', text: 'Page ' }, field('page'), { type: 'text', text: ' of ' }, field('pages')),
        );
        expect(doc.textBetween(0, doc.content.size)).toBe('Page # of #');
        expect(doc.textContent).toBe('Page # of #');
    });
});
