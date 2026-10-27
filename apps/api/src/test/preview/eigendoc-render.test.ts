import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { DEFAULT_NORMAL_STYLE, DEFAULT_PAGE_SETUP, PAGE_ROOT, STYLE_ROOT } from '@workspace/lib/docs/eigendoc';
import type { MathNode, MathRow } from '@workspace/math';
import { writeMathml } from '@workspace/math';
import * as Y from 'yjs';
import { MATHML_LIMIT } from '../../lib/export/doc/equations';
import { renderEigendocPreviewBody } from '../../lib/preview/eigendoc-render';
import { sampleChartParts } from '../fixtures/chart-parts';
import { buildGoldenDocJson, GOLDEN_MEDIA_NAME, seedEigendoc } from '../fixtures/golden-documents';

// The preview body is injected as live DOM by the drive hero and the preview pane, so every
// reference in it is fetched by the viewer's browser. A figure's `src` is collaborator data (a
// pasted <img> keeps its remote URL when it carries no mediaName), so the body goes through the
// shared ref restriction with exactly the prepared media URLs allowed through.
const MEDIA_URL = 'https://api.test/drive/o/m/file/f/preview';
const mediaUrls = new Map([[GOLDEN_MEDIA_NAME, MEDIA_URL]]);

function previewOf(json: JSONContent): string {
    const doc = new Y.Doc();
    seedEigendoc(doc, json);
    const { body } = renderEigendocPreviewBody(doc, mediaUrls);
    doc.destroy();
    return body;
}

function docWithFigure(attrs: Record<string, unknown>): JSONContent {
    return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'figure', attrs }] }] };
}

describe('renderEigendocPreviewBody', () => {
    test('the preview carries the page the doc stores, read as every reader reads it', () => {
        const doc = new Y.Doc();
        seedEigendoc(doc, docWithFigure({ mediaName: GOLDEN_MEDIA_NAME }));
        doc.getMap(PAGE_ROOT).set('width', 297);
        doc.getMap(PAGE_ROOT).set('height', 210);
        doc.getMap(PAGE_ROOT).set('marginLeft', 'wide');
        expect(renderEigendocPreviewBody(doc, mediaUrls).page).toEqual({
            ...DEFAULT_PAGE_SETUP,
            width: 297,
            height: 210,
        });
        doc.destroy();
    });

    test('the preview carries the Normal the doc stores, read as every reader reads it', () => {
        const doc = new Y.Doc();
        seedEigendoc(doc, docWithFigure({ mediaName: GOLDEN_MEDIA_NAME }));
        expect(renderEigendocPreviewBody(doc, mediaUrls).style).toEqual(DEFAULT_NORMAL_STYLE);
        doc.getMap(STYLE_ROOT).set('size', 12);
        doc.getMap(STYLE_ROOT).set('font', 'url(x)');
        expect(renderEigendocPreviewBody(doc, mediaUrls).style).toEqual({ ...DEFAULT_NORMAL_STYLE, size: 12 });
        doc.destroy();
    });

    test('a commented text draws without its highlight, as the export does', () => {
        const body = previewOf({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Noted', marks: [{ type: 'comment', attrs: { cardId: 'c1' } }] }],
                },
            ],
        });
        expect(body).toContain('Noted');
        expect(body).not.toContain('comment-highlight');
    });

    test("a figure's prepared media URL reaches the viewer", () => {
        const body = previewOf(docWithFigure({ mediaName: GOLDEN_MEDIA_NAME, alt: 'A pixel' }));
        expect(body).toContain(`src="${MEDIA_URL}"`);
    });

    test('an external image reference never reaches a viewer', () => {
        const body = previewOf(docWithFigure({ src: 'https://evil.example/pixel.png', alt: '' }));
        expect(body).not.toContain('evil.example');
    });

    test('a chart draws as inline SVG in the figure box, its labels as text', () => {
        const parts = sampleChartParts('column');
        const body = previewOf({
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'chart', attrs: { ...parts, width: 480, height: 300 } }] },
            ],
        });
        expect(body).toContain('<span class="figure" data-layout="block" data-alignment="center"><svg');
        expect(body).toMatch(/<text[^>]*>300–400<\/text>/);
    });

    // The sanitizer keeps the box's inline place, so quick look draws the layers as the editor does.
    test('a figure behind the text and a chart in front of it keep their place through the sanitizer', () => {
        const parts = sampleChartParts('column');
        const body = previewOf({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'figure',
                            attrs: {
                                mediaName: GOLDEN_MEDIA_NAME,
                                width: 300,
                                layout: 'behind',
                                offsetX: 12,
                                offsetY: 8,
                            },
                        },
                        {
                            type: 'chart',
                            attrs: { ...parts, width: 480, height: 300, layout: 'front', offsetX: 0, offsetY: -40 },
                        },
                        { type: 'text', text: 'Anchor' },
                    ],
                },
            ],
        });
        expect(body).toContain(
            '<span class="figure" data-layout="behind" data-alignment="center" data-offset-x="12" data-offset-y="8" data-width="300" style="left: 12px; top: 8px; width: 300px"><img',
        );
        expect(body).toContain(
            '<span class="figure" data-layout="front" data-alignment="center" data-offset-x="0" data-offset-y="-40" data-width="480" style="left: 0px; top: -40px; width: 480px"><svg',
        );
    });

    test('the golden document keeps its media and its hyperlink', () => {
        const body = previewOf(buildGoldenDocJson());
        expect(body).toContain(MEDIA_URL);
        expect(body).toContain('href="https://example.com/report"');
        expect(body).not.toMatch(/<script/i);
    });

    // DOMPurify's MathML profile drops <none>, which holds an empty script's place.
    test("an equation's prescript keeps its empty slot", () => {
        const x: MathRow = [{ kind: 'identifier', text: 'x' }];
        const mathml = writeMathml([{ kind: 'scripts', base: x, sub: [{ kind: 'number', text: '1' }], pre: true }]);
        const body = previewOf({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'equation', attrs: { mathml } }] }],
        });
        expect(body).toContain('<mprescripts></mprescripts><mn>1</mn><none></none>');
    });

    // A viewer's open runs it, and the block cap leaves a paragraph any number of equations: jsdom pays per element.
    test(`a paragraph's equations write at most ${MATHML_LIMIT.elements} elements of MathML, the rest as their text`, () => {
        const fence: MathNode = { kind: 'fenced', open: '', close: '', separator: '', parts: [[]] };
        // 1,332 empty fences, about all MATH_LIMITS.size admits: about 4,000 elements, so 12 fit. No LaTeX, as the docx
        // import stores an equation; the fences write no text, so i is its linear form.
        const equations = Array.from({ length: 20 }, (_, i) => ({
            type: 'equation',
            attrs: {
                mathml: writeMathml([{ kind: 'number', text: `${i}` }, ...Array.from({ length: 1332 }, () => fence)]),
            },
        }));
        const body = previewOf({ type: 'doc', content: [{ type: 'paragraph', content: equations }] });
        const drawn = body.match(/<math[\s\S]*?<\/math>/g) ?? [];

        expect(drawn.reduce((sum, math) => sum + (math.match(/<[a-z]/g)?.length ?? 0), 0)).toBeLessThanOrEqual(
            MATHML_LIMIT.elements,
        );
        expect(drawn).toHaveLength(12);
        expect(body).toContain(`</math></span>${Array.from({ length: 8 }, (_, i) => `${i + 12}`).join('')}<br></p>`);
    });

    test('an ordered list keeps its start and its type, as the export draws them', () => {
        const item = { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c' }] }] };
        const list = { type: 'orderedList', attrs: { start: 3, type: 'a' }, content: [item] };
        expect(previewOf({ type: 'doc', content: [list] })).toBe(
            '<ol start="3" type="a" style="counter-reset: list-item 2; list-style-type: lower-alpha"><li><p>c</p></li></ol>',
        );
    });

    test('a code block in a list item counts against the block cap as a top-level one does', () => {
        const code = { type: 'codeBlock', content: [{ type: 'text', text: 'x' }] };
        const list = {
            type: 'bulletList',
            content: Array.from({ length: 20 }, () => ({ type: 'listItem', content: [{ type: 'paragraph' }, code] })),
        };
        const body = previewOf({ type: 'doc', content: [code, list] });
        expect(body.match(/<pre>/g)).toHaveLength(1);
        expect(body).not.toContain('<ul>');
        expect(body).toContain('Preview truncated');
    });

    test('an empty paragraph keeps the line the editor shows', () => {
        expect(previewOf({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe('<p><br></p>');
    });
});

describe('renderEigendocPreviewBody — footnotes', () => {
    test('a reference is a linked number and its note sits in the list after the body, as the HTML download draws it', () => {
        const note = (text: string): JSONContent => ({
            type: 'footnote',
            content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        });
        const body = previewOf({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Claim' }, note('See Smith')] }],
        });
        expect(body).toContain('<sup><a href="#fn-1" id="fnref-1">1</a></sup>');
        expect(body).toContain(
            '<section class="footnotes"><hr><ol><li id="fn-1"><p>See Smith <a href="#fnref-1">↩</a></p></li></ol></section>',
        );
    });
});
