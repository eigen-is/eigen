import { describe, expect, test } from 'bun:test';
import { createDocument, generateHTML, getSchema, type JSONContent } from '@tiptap/core';
import { getDocExtensions } from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// generateHTML serializes through `document`, createDocument parses with DOMParser.
installHappyDom();

const extensions = getDocExtensions();
const figureDoc = (attrs: Record<string, unknown>): JSONContent => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'figure', attrs }] }],
});

describe('figure HTML', () => {
    // The clipboard carries a cut image as this HTML, so a commented image keeps its card like commented text.
    test("a figure's comment card survives the HTML round-trip", () => {
        const html = generateHTML(figureDoc({ mediaName: 'a.png', commentCardId: 'card-1' }), extensions);
        expect(html).toContain('<figure data-comment-id="card-1">');
        const ids: unknown[] = [];
        createDocument(html, getSchema(extensions)).descendants((node) => {
            if (node.type.name === 'figure') ids.push(node.attrs.commentCardId);
        });
        expect(ids).toEqual(['card-1']);
    });

    test('an uncommented figure writes no comment id', () => {
        expect(generateHTML(figureDoc({ mediaName: 'a.png' }), extensions)).not.toContain('data-comment-id');
    });
});

describe('figure parse', () => {
    const figuresIn = (html: string) => {
        const figures: Record<string, unknown>[] = [];
        createDocument(html, getSchema(extensions)).descendants((node) => {
            if (node.type.name === 'figure') figures.push(node.attrs);
        });
        return figures;
    };

    // The export writes a figure as spans, which a paragraph can hold, so its HTML imports back whole.
    test('an exported figure comes back with its caption, layout, alignment and width', () => {
        const figures = figuresIn(
            '<p>before <span class="figure" data-layout="wrap-left" data-alignment="center"><img src="data:image/png;base64,AA==" alt="A chart" style="width: 320px; max-width: 100%"><span class="figcaption">Sales</span></span> after</p>' +
                '<p><span class="figure" data-layout="block" data-alignment="right"><img src="data:image/png;base64,AA=="></span></p>',
        );
        expect(figures).toMatchObject([
            { src: 'data:image/png;base64,AA==', alt: 'A chart', caption: 'Sales', layout: 'wrap-left', width: 320 },
            { layout: 'block', alignment: 'right', caption: null },
        ]);
    });

    test('a figure element still parses', () => {
        expect(
            figuresIn(
                '<figure data-layout="wrap-right" data-alignment="left"><img src="a.png"><figcaption>Old</figcaption></figure>',
            ),
        ).toMatchObject([{ src: 'a.png', caption: 'Old', layout: 'wrap-right', alignment: 'left' }]);
    });
});
