import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { sampleChartSpec } from '@workspace/lib/charts';
import { DEFAULT_PAGE_SETUP, PAGE_ROOT } from '@workspace/lib/docs/eigendoc';
import { type MathNode, type MathRow, writeMathml } from '@workspace/math';
import * as Y from 'yjs';
import { MATHML_LIMIT } from '../../lib/export/doc/render';
import { renderEigendocPreviewBody } from '../../lib/preview/eigendoc-render';
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

    test("a figure's prepared media URL reaches the viewer", () => {
        const body = previewOf(docWithFigure({ mediaName: GOLDEN_MEDIA_NAME, alt: 'A pixel' }));
        expect(body).toContain(`src="${MEDIA_URL}"`);
    });

    test('an external image reference never reaches a viewer', () => {
        const body = previewOf(docWithFigure({ src: 'https://evil.example/pixel.png', alt: '' }));
        expect(body).not.toContain('evil.example');
    });

    test('a chart draws as inline SVG in the figure box, its labels as text', () => {
        const spec = JSON.stringify(sampleChartSpec('column'));
        const body = previewOf({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'chart', attrs: { spec, width: 480, height: 300 } }] }],
        });
        expect(body).toContain('<span class="figure" data-layout="block" data-alignment="center"><svg');
        expect(body).toMatch(/<text[^>]*>Team 1<\/text>/);
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

    test('an empty paragraph keeps the line the editor shows', () => {
        expect(previewOf({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe('<p><br></p>');
    });
});
