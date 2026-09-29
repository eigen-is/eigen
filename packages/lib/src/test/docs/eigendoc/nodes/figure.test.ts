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
