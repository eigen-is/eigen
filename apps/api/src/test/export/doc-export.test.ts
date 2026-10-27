import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { chartFontSize, FLAT_CHART_LOOK, newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import { getFontFamily } from '@workspace/lib/constants/fonts';
import type { NormalStyle } from '@workspace/lib/docs/eigendoc';
import { DEFAULT_PAGE_SETUP, PAGE_NUMBER_TEXT, PAGE_ROOT, pageRecord, STYLE_ROOT } from '@workspace/lib/docs/eigendoc';
import { escapeXml } from '@workspace/lib/xml';
import type { MathNode, MathRow } from '@workspace/math';
import { MATHML_NAMESPACE, writeMathml, writeText } from '@workspace/math';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';
import * as Y from 'yjs';
import * as storedEquation from '../../lib/document/equation';
import { proseValue } from '../../lib/document/prose-css';
import { toTransferableText } from '../../lib/document/transform/protocol';
import { MATHML_LIMIT } from '../../lib/export/doc/equations';
import { renderDocHtml } from '../../lib/export/doc/render';
import { MAX_BAND_BLOCKS, MAX_BAND_TEXT, MAX_PAGE_NOTES, renderEigendocExport } from '../../lib/export/doc/transform';
import * as mathSvg from '../../lib/export/math-svg';
import { sanitizeExportHtml } from '../../lib/export/sanitize';
import { isWeasyPrintAvailable, shebangPython } from '../../lib/export/weasyprint';
import renderScript from '../../lib/export/weasyprint-render.py' with { type: 'file' };
import { docxToPmJson } from '../../lib/import/doc/from-docx';
import { EMU_PER_POINT, EMU_PER_PX } from '../../lib/ooxml/ooxml';
import { openZip } from '../../lib/ooxml/zip';
import * as thumbnailTimeout from '../../lib/shared/thumbnail-timeout';
import { sampleChartParts } from '../fixtures/chart-parts';
import { corpusEquations, equation, seedBand, seedEigendoc } from '../fixtures/golden-documents';

function seededDoc(json: JSONContent = { type: 'doc', content: [paragraph('Hello')] }): Y.Doc {
    const doc = new Y.Doc();
    seedEigendoc(doc, json);
    return doc;
}

function paragraph(text: string): JSONContent {
    return { type: 'paragraph', content: [{ type: 'text', text }] };
}

// A Word 2003 body: Times at 12 pt, single, 6 pt before, nothing after, black.
const WORD_NORMAL: NormalStyle = {
    font: 'Source Serif 4',
    size: 12,
    lineSpacing: 1,
    spaceBefore: 6,
    spaceAfter: 0,
    color: '#000000',
};

function styledDoc(json?: JSONContent): Y.Doc {
    const doc = seededDoc(json);
    const map = doc.getMap(STYLE_ROOT);
    for (const [key, value] of Object.entries(WORD_NORMAL)) map.set(key, value);
    return doc;
}

function brokenDoc(): Y.Doc {
    return seededDoc({ type: 'doc', content: [paragraph('Before'), { type: 'pageBreak' }, paragraph('After')] });
}

async function docxDocumentXml(doc: Y.Doc): Promise<string> {
    const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', async () => [], undefined);
    return new TextDecoder().decode(openZip(new Uint8Array(data)).read('word/document.xml'));
}

async function exportStyle(format: 'html' | 'pdf-html', doc = seededDoc()): Promise<string> {
    const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
    return new TextDecoder().decode(data).match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
}

describe('doc export — the page', () => {
    test.each(['html', 'pdf-html'] as const)('%s draws the docs page and prints on it', async (format) => {
        const css = await exportStyle(format);

        expect(css).toContain('@page { size: 210mm 297mm; margin: 20mm 20mm 20mm 20mm; }');
        // The first .page rule is the screen page; the print one under it leaves the margins and width to @page.
        const pageRule = css.match(/\.page \{([^}]*)\}/)?.[1];
        expect(pageRule).toContain('width: 210mm;');
        expect(pageRule).toContain('padding: 20mm 20mm 20mm 20mm;');
    });

    test('docx is an A4 page with 2 cm margins', async () => {
        const xml = await docxDocumentXml(seededDoc());

        const pgSz = xml.match(/<w:pgSz\b[^>]*>/)?.[0];
        expect(pgSz).toContain('w:w="11906"');
        expect(pgSz).toContain('w:h="16838"');
        const pgMar = xml.match(/<w:pgMar\b[^>]*>/)?.[0];
        for (const side of ['top', 'right', 'bottom', 'left']) expect(pgMar).toContain(`w:${side}="1134"`);
    });

    // Letter landscape with 1 cm margins.
    function letterDoc(): Y.Doc {
        const doc = seededDoc();
        const page = { width: 279.4, height: 215.9, margin: { top: 10, right: 10, bottom: 10, left: 10 } };
        const map = doc.getMap(PAGE_ROOT);
        for (const [key, value] of Object.entries(pageRecord({ ...DEFAULT_PAGE_SETUP, ...page }))) map.set(key, value);
        return doc;
    }

    test.each(['html', 'pdf-html'] as const)('%s draws and prints the page the doc stores', async (format) => {
        const css = await exportStyle(format, letterDoc());

        expect(css).toContain('@page { size: 279.4mm 215.9mm; margin: 10mm 10mm 10mm 10mm; }');
        const pageRule = css.match(/\.page \{([^}]*)\}/)?.[1];
        expect(pageRule).toContain('width: 279.4mm;');
        expect(pageRule).toContain('padding: 10mm 10mm 10mm 10mm;');
    });

    test('docx is the page the doc stores, landscape when wider than tall', async () => {
        const xml = await docxDocumentXml(letterDoc());

        expect(xml.match(/<w:pgSz\b[^>]*>/)?.[0]).toBe('<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>');
        expect(xml.match(/<w:pgMar\b[^>]*>/)?.[0]).toBe(
            '<w:pgMar w:top="567" w:right="567" w:bottom="567" w:left="567" w:header="567" w:footer="567" w:gutter="0"/>',
        );
    });

    test("docx writes the bands' distances from the edge the doc stores", async () => {
        const doc = seededDoc();
        doc.getMap(PAGE_ROOT).set('headerDistance', 8);
        doc.getMap(PAGE_ROOT).set('footerDistance', 15);
        const pgMar = (await docxDocumentXml(doc)).match(/<w:pgMar\b[^>]*>/)?.[0];
        expect(pgMar).toContain('w:header="454"');
        expect(pgMar).toContain('w:footer="850"');
    });

    test('docx opens on the first paragraph, not an empty one', async () => {
        const xml = await docxDocumentXml(seededDoc());
        expect(xml.match(/<w:body>[\s\S]*?<\/w:p>/)?.[0]).toContain('Hello');
    });
});

describe('doc export — the Normal', () => {
    test.each(['html', 'pdf-html'] as const)(
        '%s draws the body in the Normal the doc stores, on its page',
        async (format) => {
            const css = await exportStyle(format, styledDoc());
            expect(css).toContain(
                `.page { --doc-font-family: ${getFontFamily('Source Serif 4')}; --doc-font-size: 12pt; --doc-line-height: 1.21; --doc-space-before: 6pt; --doc-space-after: 0pt; --doc-color: #000000; }`,
            );
            // A doc without the map declares none, so it renders as before the map.
            expect(await exportStyle(format)).not.toMatch(/--doc-[\w-]+:/);
        },
    );

    // Upright Source Serif 4 has small caps of its own, so text in a Source Serif Normal keeps them as typed.
    test("the pdf fakes small caps by the Normal's font where a run has none of its own", async () => {
        const doc = styledDoc({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Serif', marks: [{ type: 'textStyle', attrs: { caps: 'small' } }] },
                    ],
                },
            ],
        });
        const { data } = await renderEigendocExport(doc, 'pdf-html', 'Report.eigendoc', async () => [], undefined);
        expect(new TextDecoder().decode(data)).toContain('<span style="font-variant-caps: small-caps">Serif</span>');
    });

    test("docx writes the Normal as docDefaults and the Normal style, in the Normal's font's own line", async () => {
        const { data } = await renderEigendocExport(styledDoc(), 'docx', 'Report.eigendoc', async () => [], undefined);
        const styles = new TextDecoder().decode(openZip(new Uint8Array(data)).read('word/styles.xml'));
        expect(styles).toContain(
            '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Source Serif 4" w:hAnsi="Source Serif 4" w:eastAsia="Source Serif 4" w:cs="Source Serif 4"/><w:color w:val="000000"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>',
        );
        // A heading and the title draw in the Normal's font, so their line is the editor's 1.2 in Source Serif 4's own.
        for (const id of ['Heading1', 'Title'])
            expect(styles).toMatch(
                new RegExp(`w:styleId="${id}">(?:(?!</w:style>).)*<w:spacing [^>]*w:line="210" w:lineRule="auto"/>`),
            );
        // Single in Inter's line is Source Serif 4's 1.21 / 1.371 of its own.
        expect(styles).toMatch(
            /w:styleId="Normal"><w:name w:val="Normal"\/><w:qFormat\/><w:pPr><w:spacing w:before="120" w:after="0" w:line="212" w:lineRule="auto"\/>/,
        );
    });
});

describe('doc export — the stylesheet', () => {
    // The app's tokens (--font-sans and the like) are not in the export; a property the stylesheet declares itself is.
    // A doc's Normal (--doc-*) is declared only where it is the doc's own, so those fall back to Eigen's.
    test.each(['html', 'pdf-html'] as const)(
        '%s declares every CSS variable it reads without a fallback',
        async (format) => {
            const css = await exportStyle(format);
            for (const [, name] of css.matchAll(/var\((--[\w-]+)\)/g)) expect(css).toContain(`${name}:`);
            expect([...css.matchAll(/var\((--[\w-]+),/g)].every(([, name]) => name?.startsWith('--doc-'))).toBe(true);
        },
    );

    test('headings print at medium and bold at 600', async () => {
        const css = await exportStyle('pdf-html');
        expect(css).toMatch(/h6 \{[^}]*font-weight: 500;/);
        expect(css).toMatch(/\.eigen-prose th \{[^}]*font-weight: 500;/);
        expect(css).toMatch(/strong \{ font-weight: 600; \}/);
    });

    test('h5 and h6 print at the body size, which only eigen-prose sets', async () => {
        const css = await exportStyle('pdf-html');
        expect(css).toContain('h1, h2, h3, h4, h5, h6 { font-size: inherit; }');
        expect(css.match(/font-size: var\(--doc-font-size, 11pt\)/g)).toHaveLength(1);
    });

    // Google Docs' Title and Subtitle, which the docx writer reads too.
    test.each(['html', 'pdf-html'] as const)(
        '%s draws the title and subtitle at their size, the subtitle grey',
        async (format) => {
            const css = await exportStyle(format);
            expect(css).toMatch(/\.eigen-prose p\[data-type="title"\] \{[^}]*font-size: 26pt;[^}]*line-height: 1\.2;/);
            expect(css).toMatch(/\.eigen-prose p\[data-type="subtitle"\] \{ font-size: 15pt;/);
            expect(css).toMatch(/, \.eigen-prose p\[data-type="subtitle"\] \{ color: #666666; \}/);
        },
    );

    test('the body text font and color are set once, by eigen-prose', async () => {
        const css = await exportStyle('pdf-html');
        expect(css).not.toMatch(/(^|\n)\s*body \{/);
        expect(css.match(/#1a1a2e/g)).toHaveLength(1);
    });

    test('the dark theme stays out, whole', async () => {
        const css = await exportStyle('pdf-html');
        expect(css).not.toMatch(/#3f3f46|#27272a/);
        // A leftover closing brace would swallow the rule after it.
        expect(css.split('}').length).toBe(css.split('{').length);
    });

    test('a page break starts the next page in print', async () => {
        expect(await exportStyle('pdf-html')).toContain('break-after: page');
    });

    test('a table and its rows may split, a quote holding a page break may split, and the figure box stays whole', async () => {
        const css = await exportStyle('pdf-html');

        expect(css).toContain('.figure, pre, blockquote { page-break-inside: avoid; }');
        expect(css).toContain('blockquote:has(.page-break) { page-break-inside: auto; }');
        expect(css).not.toMatch(/(table|tr) \{ page-break-inside: avoid/);
    });
});

// A face is up to 0.6 MB of base64, so a doc embeds only the families it can draw in; a missing one would print in
// a system font.
describe('doc export — fonts', () => {
    const embedded = async (doc: Y.Doc, format: 'html' | 'pdf-html' = 'pdf-html') => [
        ...new Set([...(await exportStyle(format, doc)).matchAll(/font-family: "([^"]+)";\s*src:/g)].map((m) => m[1])),
    ];
    const marked = (fontFamily: string) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Marked', marks: [{ type: 'textStyle', attrs: { fontFamily } }] }],
    });

    test.each(['html', 'pdf-html'] as const)('a plain doc in %s embeds its Normal font alone', async (format) => {
        expect(await embedded(seededDoc(), format)).toEqual(['Inter']);
        expect(await embedded(styledDoc(), format)).toEqual(['Source Serif 4']);
    });

    test("a font mark, a band's, code, a note's and a chart's font each embed their family", async () => {
        expect(await embedded(seededDoc({ type: 'doc', content: [marked('Excalifont')] }))).toEqual([
            'Inter',
            'Excalifont',
        ]);
        expect(
            await embedded(
                seededDoc({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }] }),
            ),
        ).toEqual(['Inter', 'JetBrains Mono']);
        expect(
            await embedded(
                seededDoc({
                    type: 'doc',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'code' }] }] }],
                }),
            ),
        ).toEqual(['Inter', 'JetBrains Mono']);
        const banded = seededDoc();
        seedBand(banded, 'header', marked('Source Serif 4'));
        expect(await embedded(banded)).toEqual(['Inter', 'Source Serif 4']);
        const noted = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Claim' },
                        { type: 'footnote', content: [marked('Excalifont')] },
                    ],
                },
            ],
        });
        expect(await embedded(noted)).toEqual(['Inter', 'Excalifont']);
        const chart = (fontFamily: string) =>
            seededDoc({
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            {
                                type: 'chart',
                                attrs: {
                                    ...sampleChartParts('column', fontFamily),
                                    width: 400,
                                    height: 240,
                                },
                            },
                        ],
                    },
                ],
            });
        expect(await embedded(chart('Source Serif 4'))).toEqual(['Inter', 'Source Serif 4']);
        const serifChart = chart('Inter');
        for (const [key, value] of Object.entries(WORD_NORMAL)) serifChart.getMap(STYLE_ROOT).set(key, value);
        expect(await embedded(serifChart)).toEqual(['Inter', 'Source Serif 4']);
    });
});

describe('doc export — losses', () => {
    // The writer counts what it leaves out, and the transform returns the counts; the HTML draws the chart's placeholder.
    test('a docx export returns the chart it left out as a warning, and the HTML export counts nothing', async () => {
        const doc = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'chart', attrs: { ...sampleChartParts('column'), specData: '{' } }],
                },
            ],
        });
        const docx = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', async () => [], undefined);
        expect(docx.warnings).toEqual([{ code: 'charts-dropped', count: 1 }]);
        const html = await renderEigendocExport(doc, 'html', 'Report.eigendoc', async () => [], undefined);
        expect(html.warnings).toEqual([]);
    });

    // Comments are not exported, so the HTML draws no highlight for one, as the PDF and the docx don't; the text stays.
    test.each(['html', 'pdf-html'] as const)('%s keeps a commented text and drops its highlight', async (format) => {
        const doc = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Noted', marks: [{ type: 'comment', attrs: { cardId: 'c1' } }] }],
                },
            ],
        });
        const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
        const body = new TextDecoder().decode(data).split('<body>')[1] ?? '';
        expect(body).toContain('Noted');
        expect(body).not.toContain('comment-highlight');
        expect(body).not.toContain('data-comment-id');
    });
});

describe('doc export — tasks', () => {
    // A line-through reaches every descendant and none can undo it, so what each strike rule hits is what prints struck.
    test.each(['html', 'pdf-html'] as const)(
        '%s strikes a done task but not the open task inside it',
        async (format) => {
            const task = (checked: boolean, text: string, nested: JSONContent[] = []): JSONContent => ({
                type: 'taskItem',
                attrs: { checked },
                content: [paragraph(text), ...nested],
            });
            const doc = seededDoc({
                type: 'doc',
                content: [
                    {
                        type: 'taskList',
                        content: [task(true, 'Done', [{ type: 'taskList', content: [task(false, 'Still open')] }])],
                    },
                ],
            });
            const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
            const { window } = new JSDOM(new TextDecoder().decode(data));
            const { document } = window;
            const struck = [...document.styleSheets]
                .flatMap((sheet) => [...sheet.cssRules])
                .filter((rule) => rule instanceof window.CSSStyleRule)
                .filter((rule) => rule.style.getPropertyValue('text-decoration').includes('line-through'))
                .flatMap((rule) => [...document.querySelectorAll(rule.selectorText)].map((node) => node.textContent));
            expect(struck).toEqual(['Done']);
        },
    );
});

describe('doc export — figures', () => {
    const media = [{ name: 'chart.png', contentType: 'image/png', data: new ArrayBuffer(1) }];
    const IMG = '<img src="data:image/png;base64,AA==" alt="" style="width: 320px; max-width: 100%" />';

    async function exportHtml(json: JSONContent): Promise<string> {
        const { data } = await renderEigendocExport(
            seededDoc(json),
            'html',
            'Report.eigendoc',
            async () => media,
            undefined,
        );
        return new TextDecoder().decode(data);
    }

    // A <figure> in a <p> would close it in every HTML parser, the browser's and WeasyPrint's, splitting the paragraph.
    test('a figure is spans its paragraph holds, the box the editor draws', async () => {
        const html = await exportHtml({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'before ' },
                        {
                            type: 'figure',
                            attrs: { mediaName: 'chart.png', width: 320, alignment: 'right', caption: 'Sales' },
                        },
                        { type: 'text', text: ' after' },
                    ],
                },
            ],
        });
        expect(html).toContain(
            `<p>before <span class="figure" data-layout="block" data-alignment="right">${IMG.replace(' />', '>')}<span class="figcaption">Sales</span></span> after</p>`,
        );
    });

    test("a wrapped figure floats by the stylesheet's rule, which the docx writer reads too", async () => {
        const figure = (layout: string) => ({
            type: 'paragraph',
            content: [{ type: 'figure', attrs: { mediaName: 'chart.png', width: 320, layout } }],
        });
        const html = await exportHtml({ type: 'doc', content: [figure('wrap-left'), figure('wrap-right')] });
        expect(html).toContain('<span class="figure" data-layout="wrap-left" data-alignment="center"><img');
        expect(html).toContain('<span class="figure" data-layout="wrap-right" data-alignment="center"><img');
        expect(proseValue('.eigen-prose .figure[data-layout="wrap-left"]', 'float')).toBe('left');
        expect(proseValue('.eigen-prose .figure[data-layout="wrap-left"]', 'margin')).toBe('0.25em 1em 0.5em 0');
        expect(proseValue('.eigen-prose .figure[data-layout="wrap-right"]', 'float')).toBe('right');
        expect(proseValue('.eigen-prose .figure[data-layout="wrap-right"]', 'margin')).toBe('0.25em 0 0.5em 1em');
    });
});

describe('doc export — figures in front of and behind the text', () => {
    const media = [{ name: 'chart.png', contentType: 'image/png', data: new ArrayBuffer(1) }];
    const placed = (layout: string) => ({
        type: 'figure',
        attrs: { mediaName: 'chart.png', width: 320, layout, offsetX: -24, offsetY: 130.5, caption: 'Hidden' },
    });
    const anchored = (layout: string): JSONContent => ({
        type: 'paragraph',
        content: [placed(layout), { type: 'text', text: 'Anchor' }],
    });

    async function exportHtml(json: JSONContent, doc = seededDoc(json)): Promise<string> {
        const { data } = await renderEigendocExport(doc, 'html', 'Report.eigendoc', async () => media, undefined);
        return new TextDecoder().decode(data);
    }

    // The sanitized download carries the box's place and width inline, and the offsets and the width a paste back into
    // Docs reads; the stylesheet gives it its layer.
    test.each(['front', 'behind'])('a %s figure is a box at its offsets from its paragraph', async (layout) => {
        const html = await exportHtml({ type: 'doc', content: [anchored(layout)] });
        expect(html).toContain(
            `<p><span class="figure" data-layout="${layout}" data-alignment="center" data-offset-x="-24" data-offset-y="130.5" data-width="320" style="left: -24px; top: 130.5px; width: 320px"><img`,
        );
    });

    // The paper is the layers' stacking context, in a browser and in WeasyPrint, which reads no `isolation`.
    test.each(['html', 'pdf-html'] as const)('%s stacks the layers on the page', async (format) => {
        expect(await exportStyle(format)).toMatch(/\.page \{[^}]*position: relative;[^}]*z-index: 0;/);
    });

    // A cell, a note and a band have no body paragraph to anchor on, so a forged one draws in line.
    test('a positioned figure in a table cell, a note or a band draws in line', async () => {
        const cell = (type: string) => ({ type, content: [anchored('front')] });
        const json: JSONContent = {
            type: 'doc',
            content: [
                { type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader'), cell('tableCell')] }] },
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Noted' },
                        { type: 'footnote', content: [anchored('behind')] },
                    ],
                },
            ],
        };
        const doc = seededDoc(json);
        seedBand(doc, 'header', { type: 'doc', content: [anchored('behind')] });
        const body = (await exportHtml(json, doc)).split('<body')[1];
        expect(body?.match(/data-layout="block"/g)).toHaveLength(4);
        expect(body).not.toMatch(/data-layout="(front|behind)"|style="left/);
    });

    test('the body anchors a positioned figure in a list item or a quote', async () => {
        const html = await exportHtml({
            type: 'doc',
            content: [
                { type: 'bulletList', content: [{ type: 'listItem', content: [anchored('front')] }] },
                { type: 'blockquote', content: [anchored('behind')] },
            ],
        });
        expect(html).toContain(
            'data-layout="front" data-alignment="center" data-offset-x="-24" data-offset-y="130.5" data-width="320" style="left: -24px',
        );
        expect(html).toContain(
            'data-layout="behind" data-alignment="center" data-offset-x="-24" data-offset-y="130.5" data-width="320" style="left: -24px',
        );
    });
});

describe('doc export — charts', () => {
    const PARTS = sampleChartParts('column');
    const chartDoc = (attrs: Record<string, unknown>, spec = sampleChartSpec('column')): JSONContent => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'chart', attrs: { ...newChartSpecParts(spec), ...attrs } }] }],
    });

    // Inline, so WeasyPrint draws the labels in the page's own fonts; an <img> of an SVG can't reach @font-face.
    test.each(['html', 'pdf-html'] as const)(
        '%s draws a chart as inline SVG at its size in the figure box, its labels as text',
        async (format) => {
            const doc = seededDoc(chartDoc({ width: 480, height: 300, alignment: 'right', caption: 'Points' }));
            const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
            const html = new TextDecoder().decode(data);
            expect(html).toContain(
                '<span class="figure" data-layout="block" data-alignment="right"><svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">',
            );
            // Never wider than the column, its height following, by the prose rule the editor's node view draws with.
            expect(html).toMatch(/\.figure svg\s*\{[^}]*max-width: 100%;[^}]*height: auto;/);
            expect(html).toContain(`>${sampleChartSpec('column').axes.x.title.text}</text>`);
            expect(html).toContain('</svg><span class="figcaption">Points</span></span>');
            expect(html).not.toContain('<img');
        },
    );

    test('docx writes a chart as a Word chart, its own part, with no picture', async () => {
        const doc = seededDoc(chartDoc({ width: 480, height: 300 }));
        const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', async () => [], undefined);
        const names = openZip(new Uint8Array(data)).names();
        expect(names.filter((name) => name.startsWith('word/media/'))).toEqual([]);
        expect(names.filter((name) => name.startsWith('word/charts/'))).toEqual([
            'word/charts/chart1.xml',
            'word/charts/_rels/chart1.xml.rels',
        ]);
        expect(names).toContain('word/embeddings/Microsoft_Excel_Worksheet1.xlsx');
    });

    test("a chart wider than the column shrinks to it, its text and lines with it, at Eigen's size for its box", async () => {
        const doc = seededDoc(chartDoc({ width: 1600, height: 800 }));
        const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', async () => [], undefined);
        const zip = openZip(new Uint8Array(data));
        const read = (name: string) => new TextDecoder().decode(zip.read(name));
        const [, cx = '0', cy = '0'] = read('word/document.xml').match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/) ?? [];
        const emuPerPx = Number(cx) / 1600;
        expect(emuPerPx).toBeLessThan(EMU_PER_PX / 2);
        expect(Number(cy) / Number(cx)).toBeCloseTo(0.5, 3);
        const chart = read('word/charts/chart1.xml');
        const size = Math.round(((chartFontSize(1600, 800) * emuPerPx) / EMU_PER_POINT) * 100);
        expect(chart).toContain(`<a:defRPr sz="${size}">`);
        expect(chart).toContain(`<a:ln w="${Math.round(FLAT_CHART_LOOK.strokeWidth * emuPerPx)}">`);
    });

    test("every label draws in the spec's font", () => {
        const fontsOf = (html: string) =>
            new Set(Array.from(html.matchAll(/<text[^>]*font-family="([^"]*)"/g), (m) => m[1]));
        const face = (font: string) => new Set([escapeXml(getFontFamily(font))]);
        expect(fontsOf(renderDocHtml(chartDoc({}), () => null))).toEqual(face('Inter'));
        const serif = sampleChartSpec('column', 'Source Serif 4');
        expect(fontsOf(renderDocHtml(chartDoc({}, serif), () => null))).toEqual(face('Source Serif 4'));
    });

    // Two gradient charts on a page: each draws its own gradient, never the other's.
    test("draws each chart's stored look, its gradient under an id of its own", async () => {
        const gradient = (from: string) =>
            JSON.stringify({ type: 'gradient', from, to: 'transparent', angle: 90, style: 'cross-hatch' });
        const look = { roughness: 2, seed: 5, strokeColor: '#336699', fill: gradient('#ffeeaa') };
        const chart = (attrs: Record<string, unknown>) => ({ type: 'chart', attrs: { ...PARTS, ...attrs } });
        const doc: JSONContent = {
            type: 'doc',
            content: [{ type: 'paragraph', content: [chart(look), chart({ ...look, fill: gradient('#aaeeff') })] }],
        };
        const { data } = await renderEigendocExport(
            seededDoc(doc),
            'pdf-html',
            'Report.eigendoc',
            async () => [],
            undefined,
        );
        const html = sanitizeExportHtml(new TextDecoder().decode(data));
        const ids = Array.from(html.matchAll(/<linearGradient id="([^"]+)"/g), (m) => m[1]);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);
        for (const id of ids) expect(html).toContain(`url(#${id})`);
        expect(html).toContain('stroke="#336699"');
        expect(html).not.toBe(renderDocHtml(chartDoc({}), () => null));
    });

    test('the sanitizer keeps every shape and label of the chart', () => {
        const raw = renderDocHtml(chartDoc({ width: 480, height: 300 }), () => null);
        const count = (html: string, tag: string) => html.split(`<${tag}`).length - 1;
        const kept = sanitizeExportHtml(raw);
        for (const tag of ['svg', 'g', 'path', 'text']) {
            expect(count(raw, tag)).toBeGreaterThan(0);
            expect(count(kept, tag)).toBe(count(raw, tag));
        }
    });
});

// The editor's ProseMirror ends a textblock with a <br> wherever its last line would otherwise collapse (addTextblockHacks).
describe('doc export — trailing breaks', () => {
    async function bodyOf(...content: JSONContent[]): Promise<string> {
        const { data } = await renderEigendocExport(
            seededDoc({ type: 'doc', content }),
            'html',
            'Report.eigendoc',
            async () => [],
            undefined,
        );
        const html = new TextDecoder().decode(data);
        return html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    }

    test('an empty paragraph or heading keeps its line', async () => {
        expect(await bodyOf({ type: 'paragraph' }, { type: 'heading', attrs: { level: 2 } })).toContain(
            '<p><br></p><h2><br></h2>',
        );
    });

    test('a title and a subtitle render as the p the editor holds, an empty one keeping its line', async () => {
        const body = await bodyOf(
            { type: 'title', content: [{ type: 'text', text: 'Plan' }] },
            { type: 'subtitle', attrs: { textAlign: 'center' } },
        );
        expect(body).toContain(
            '<p data-type="title">Plan</p><p data-type="subtitle" style="text-align: center"><br></p>',
        );
    });

    test('a textblock ending in an inline node or a newline gets the break, one ending in text none', async () => {
        const body = await bodyOf(
            { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'b\n' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'c', marks: [{ type: 'bold' }] }] },
            { type: 'heading', attrs: { level: 3 }, content: [{ type: 'figure', attrs: { caption: 'x' } }] },
        );
        expect(body).toContain('<p>a<br><br></p><p>b\n<br></p><p><strong>c</strong></p>');
        expect(body).toContain(
            '<h3><span class="figure" data-layout="block" data-alignment="center"><span class="figcaption">x</span></span><br></h3>',
        );
    });

    test('a paragraph in a list item, a quote or a cell gets it too', async () => {
        const empty = { type: 'paragraph' };
        const body = await bodyOf(
            { type: 'bulletList', content: [{ type: 'listItem', content: [empty] }] },
            { type: 'blockquote', content: [empty] },
            { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [empty] }] }] },
        );
        expect(body).toContain('<li><p><br></p></li>');
        expect(body).toContain('<blockquote><p><br></p></blockquote>');
        expect(body).toMatch(/<td[^>]*><p><br><\/p><\/td>/);
    });

    test('a code block over 64 kB with no language renders plain, one with a language still highlights', () => {
        const long = 'const a = 1;\n'.repeat(Math.ceil((64 * 1024) / 13) + 1);
        const block = (language: string | null) => ({
            type: 'doc',
            content: [{ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: long }] }],
        });
        const plain = renderDocHtml(block(null), () => null);
        expect(plain).toStartWith('<pre><code class="hljs">const a = 1;\n');
        expect(plain).not.toContain('<span');
        expect(renderDocHtml(block('javascript'), () => null)).toContain('<span class="hljs-keyword">const</span>');
    });

    test('a render spends one 64 kB budget across its code blocks with no language, the rest render plain', () => {
        const half = 'const a = 1;\n'.repeat(Math.ceil((32 * 1024) / 13) + 1);
        const block = { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: half }] };
        const [first, second] = renderDocHtml({ type: 'doc', content: [block, block] }, () => null).split('</pre>');
        expect(first).toContain('<span');
        expect(second).not.toContain('<span');
    });

    test.each([[5], [true], [{ a: 1 }], [['js']]])(
        'a code block whose stored language is %p renders as one with none',
        (language) => {
            const json = {
                type: 'doc',
                content: [{ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: 'x' }] }],
            };
            expect(renderDocHtml(json, () => null)).toStartWith('<pre><code class="hljs">');
        },
    );

    test('an empty code block or one ending in a newline keeps its last line, one ending in text gets none', async () => {
        const code = (text?: string) => ({
            type: 'codeBlock',
            attrs: { language: 'plaintext' },
            content: text === undefined ? undefined : [{ type: 'text', text }],
        });
        const body = await bodyOf(code(), code('a\n'), code('b'));
        expect(body).toContain(
            '<pre><code class="hljs language-plaintext"><br></code></pre><pre><code class="hljs language-plaintext">a\n<br></code></pre><pre><code class="hljs language-plaintext">b</code></pre>',
        );
    });
});

describe('doc export — page breaks', () => {
    test.each(['html', 'pdf-html'] as const)('%s carries the page break div', async (format) => {
        const { data } = await renderEigendocExport(brokenDoc(), format, 'Report.eigendoc', async () => [], undefined);
        expect(new TextDecoder().decode(data)).toContain('<p>Before</p><div class="page-break"></div><p>After</p>');
    });

    test('docx writes a top-level page break as a Word page break', async () => {
        expect(await docxDocumentXml(brokenDoc())).toContain('<w:br w:type="page"/>');
    });

    test('docx keeps a page break nested in a list item', async () => {
        const nested = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'bulletList',
                    content: [{ type: 'listItem', content: [paragraph('Before'), { type: 'pageBreak' }] }],
                },
            ],
        });
        expect(await docxDocumentXml(nested)).toContain('<w:br w:type="page"/>');
    });

    test('a docx export imports back to the same blocks', async () => {
        const { data } = await renderEigendocExport(brokenDoc(), 'docx', 'Report.eigendoc', async () => [], undefined);
        const { json } = docxToPmJson(Buffer.from(data));
        expect(json.content?.map((node) => node.type)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
    });
});

// The declarations of a rule in an export's stylesheet.
function proseCssRule(html: string, selector: string): string {
    const at = html.indexOf(`${selector} {`);
    return at < 0 ? '' : html.slice(at, html.indexOf('}', at));
}

describe('doc export — equations', () => {
    const MATH = `<math xmlns="${MATHML_NAMESPACE}">`;
    const x: MathRow = [{ kind: 'identifier', text: 'x' }];
    const y: MathRow = [{ kind: 'identifier', text: 'y' }];
    const fence: MathNode = { kind: 'fenced', open: '', close: '', separator: '', parts: [[]] };
    const integral: MathNode = { kind: 'operator', text: '⨌' };
    // 1,332 empty fences, about all MATH_LIMITS.size admits: about 4,000 elements of MathML and of SVG, so 12 fit. No
    // LaTeX, as the docx import stores an equation; the fences write no text, so i is its linear form.
    const fences = (i: number) => ({
        mathml: writeMathml([{ kind: 'number', text: `${i}` }, ...Array.from({ length: 1332 }, () => fence)]),
    });
    const fenceRun = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => fences(from + i));
    const fenceTexts = (from: number, to: number) =>
        Array.from({ length: to - from }, (_, i) => `${from + i}`).join('');
    const elements = (markup: string) => markup.match(/<[a-z]/g)?.length ?? 0;

    async function exportEquations(format: 'html' | 'pdf-html', ...attrs: Record<string, unknown>[]): Promise<string> {
        const equations = attrs.map((a) => ({ type: 'equation', attrs: a }));
        const doc = seededDoc({ type: 'doc', content: [{ type: 'paragraph', content: equations }] });
        const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
        return new TextDecoder().decode(data);
    }

    // No screen draws the annotation, and an HTML sanitizer that drops it keeps its LaTeX as text. The editor's span,
    // so a displayed one takes its line as the editor's does, ending on the line the trailing <br> holds.
    test('an equation is its MathML without the LaTeX in the editor\'s span, display="block" when it is displayed', async () => {
        const html = await exportEquations(
            'html',
            { mathml: writeMathml(x, 'x') },
            { mathml: writeMathml(x, 'x'), display: true },
        );
        expect(html).toContain(
            `<p><span class="equation">${MATH}<mi>x</mi></math></span><span class="equation" data-display="block"><math display="block" xmlns="${MATHML_NAMESPACE}"><mi>x</mi></math></span><br></p>`,
        );
        expect(proseCssRule(html, '.eigen-prose .equation[data-display]')).toContain('width: 100%');
        expect(html).not.toContain('x-tex');
        expect(html).not.toContain('<svg');
    });

    // WeasyPrint draws no MathML.
    test('the PDF draws an equation as SVG, a displayed one in a block', async () => {
        const html = await exportEquations(
            'pdf-html',
            { mathml: writeMathml(x, 'x') },
            { mathml: writeMathml(y, 'y'), display: true },
        );
        expect(html).toMatch(
            /<p><span class="math-svg"><svg [^>]*>[\s\S]*?<\/svg><\/span><span class="math-svg" data-display="block"><svg [^>]*>[\s\S]*?<\/svg><\/span><br><\/p>/,
        );
        expect(html.match(/<svg/g)).toHaveLength(2);
        expect(html).not.toMatch(/<math|x-tex/);
    });

    // CSS's + skips text, so a rule hiding the <br> after a displayed equation would hide a user's break after text
    // that follows it. The drawing takes its line as the editor's does instead, ending on the trailing <br>'s line.
    test("the PDF keeps a user's break after a displayed equation", async () => {
        const doc = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'equation', attrs: { mathml: writeMathml(y, 'y'), display: true } },
                        { type: 'text', text: 'AFTER' },
                        { type: 'hardBreak' },
                        { type: 'text', text: 'MORE' },
                    ],
                },
            ],
        });
        const { data } = await renderEigendocExport(doc, 'pdf-html', 'Report.eigendoc', async () => [], undefined);
        const html = new TextDecoder().decode(data);

        expect(html).toMatch(/<\/svg><\/span>AFTER<br>MORE<\/p>/);
        expect(html).not.toMatch(/\+\s*br\s*\{/);
        expect(proseCssRule(html, '.math-svg[data-display]')).toMatch(/display: inline-block;[^}]*width: 100%/);
    });

    // MathJax draws each string once. Past its last drawing a repeat of a drawn one is text too, so the text is a tail.
    test(`past ${mathSvg.MAX_SVG_EQUATIONS} drawings the PDF writes the rest as their text`, async () => {
        const numbers = Array.from({ length: mathSvg.MAX_SVG_EQUATIONS }, (_, i) => ({
            mathml: writeMathml([{ kind: 'number', text: String(i) }], String(i)),
        }));
        const mathmlToSvg = spyOn(mathSvg, 'mathmlToSvg');
        try {
            const html = await exportEquations(
                'pdf-html',
                numbers[0],
                ...numbers,
                { mathml: writeMathml(y, 'y') },
                numbers[0],
            );
            expect(html.match(/class="math-svg"/g)).toHaveLength(mathSvg.MAX_SVG_EQUATIONS + 1);
            expect(html).toContain('</svg></span>y0<br></p>');
            expect(mathmlToSvg).toHaveBeenCalledTimes(mathSvg.MAX_SVG_EQUATIONS);
        } finally {
            mathmlToSvg.mockRestore();
        }
    }, 60_000);

    // A row of 1,997 ⨌, about all MATH_LIMITS.size admits: 24 KB of MathML, about 4.1 MB of SVG. Each copy counts, as
    // the sanitizer and WeasyPrint read each, and MathJax stops at the one that does not fit.
    test(`the PDF draws at most ${mathSvg.SVG_LIMIT.bytes} bytes of SVG, and the rest as their text`, async () => {
        const row = (i: number): MathRow => [
            { kind: 'number', text: `${i}` },
            ...Array.from({ length: 1997 }, () => integral),
        ];
        const wide = (i: number) => ({ mathml: writeMathml(row(i)) });
        const equations = [wide(0), wide(0), ...Array.from({ length: 18 }, (_, i) => wide(i + 1))];
        const draw = mathSvg.mathmlToSvg;
        const built: number[] = [];
        const mathmlToSvg = spyOn(mathSvg, 'mathmlToSvg').mockImplementation(async (mathml) => {
            const svg = await draw(mathml);
            built.push(Buffer.byteLength(svg));
            return svg;
        });
        try {
            const html = await exportEquations('pdf-html', ...equations);
            const drawn = html.match(/<span class="math-svg">[\s\S]*?<\/svg><\/span>/g) ?? [];
            const texts = html.slice(
                html.lastIndexOf('</svg></span>') + '</svg></span>'.length,
                html.indexOf('<br></p>'),
            );

            expect(drawn.reduce((bytes, svg) => bytes + Buffer.byteLength(svg), 0)).toBeLessThanOrEqual(
                mathSvg.SVG_LIMIT.bytes,
            );
            expect(built.slice(0, -1).reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(
                mathSvg.SVG_LIMIT.bytes,
            );
            expect(drawn).toHaveLength(2);
            expect(mathmlToSvg).toHaveBeenCalledTimes(2);
            expect(texts).toBe(Array.from({ length: 18 }, (_, i) => writeText(row(i + 1))).join(''));
        } finally {
            mathmlToSvg.mockRestore();
        }
    }, 60_000);

    // Each fences() draws 0.15 MB, where bytes alone would admit 68 copies. A copy past the budget is text, as WeasyPrint
    // would draw it again.
    test(`the PDF draws at most ${mathSvg.SVG_LIMIT.elements} elements of SVG, and the rest as their text`, async () => {
        const equations = [fences(0), ...fenceRun(0, 11), fences(0), ...fenceRun(11, 16)];
        const mathmlToSvg = spyOn(mathSvg, 'mathmlToSvg');
        try {
            const html = await exportEquations('pdf-html', ...equations);
            const drawn = html.match(/<span class="math-svg">[\s\S]*?<\/svg><\/span>/g) ?? [];
            const texts = html.slice(
                html.lastIndexOf('</svg></span>') + '</svg></span>'.length,
                html.indexOf('<br></p>'),
            );

            expect(drawn.reduce((sum, svg) => sum + elements(svg), 0)).toBeLessThanOrEqual(mathSvg.SVG_LIMIT.elements);
            expect(drawn).toHaveLength(12);
            expect(mathmlToSvg).toHaveBeenCalledTimes(11);
            expect(texts).toBe(`0${fenceTexts(11, 16)}`);
        } finally {
            mathmlToSvg.mockRestore();
        }
    }, 60_000);

    // The HTML download and the preview write MathML, which jsdom pays for by the element, every copy. Past the budget
    // an equation is its linear text, whether it carries LaTeX or not.
    test(`the HTML writes at most ${MATHML_LIMIT.elements} elements of MathML, and the rest as their text`, async () => {
        const half: MathRow = [
            { kind: 'fraction', numerator: x, denominator: [{ kind: 'number', text: '2' }], line: 'bar' },
        ];
        const readStoredEquation = spyOn(storedEquation, 'readStoredEquation');
        try {
            const html = await exportEquations('html', fences(0), ...fenceRun(0, 12), fences(0), fences(12), {
                mathml: writeMathml(half, '\\frac{x}{2}'),
            });
            const drawn = html.match(/<math[\s\S]*?<\/math>/g) ?? [];

            expect(drawn.reduce((sum, math) => sum + elements(math), 0)).toBeLessThanOrEqual(MATHML_LIMIT.elements);
            expect(drawn).toHaveLength(12);
            // Each distinct equation is read once to draw, and each past the budget once more for its text.
            expect(readStoredEquation).toHaveBeenCalledTimes(12 + 4);
            expect(html).toContain('</math></span>11012x/2<br></p>');
        } finally {
            readStoredEquation.mockRestore();
        }
    });

    // The schema refuses an equation in a code block, a figure or another equation, but a Yjs update can hold one.
    // The render skips it, and every other equation still draws as itself.
    test.each(['html', 'pdf-html'] as const)(
        '%s draws each equation as itself around one the render skips',
        async (format) => {
            const digit = (d: number) => equation(writeMathml([{ kind: 'number', text: `${d}` }], `${d}`));
            const doc = seededDoc({
                type: 'doc',
                content: [
                    { type: 'paragraph', content: [digit(1)] },
                    { type: 'codeBlock', content: [{ type: 'text', text: 'c' }, digit(2)] },
                    { type: 'paragraph', content: [{ ...digit(3), content: [digit(4)] }] },
                    {
                        type: 'paragraph',
                        content: [{ type: 'figure', attrs: { caption: 'c' }, content: [digit(5)] }, digit(6)],
                    },
                    { type: 'paragraph', content: [digit(7)] },
                ],
            });
            const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
            const html = new TextDecoder().decode(data);
            // MathJax names each glyph by its code point: 0x31 is 1.
            const drawn = format === 'html' ? /<mn>(\d)<\/mn>/g : /<span class="math-svg">[\s\S]*?data-c="3(\d)"/g;

            expect([...html.matchAll(drawn)].map((match) => match[1])).toEqual(['1', '3', '6', '7']);
        },
    );

    // The 108 corpus equations, over and over: a paper of 1,000 shows every one, in both budgets.
    test('a 1,000-equation paper draws every equation', async () => {
        const corpus = corpusEquations();
        const paper = Array.from({ length: 1000 }, (_, i) => {
            const { row, display } = corpus[i % corpus.length];
            return { mathml: writeMathml(row), display };
        });

        expect((await exportEquations('html', ...paper)).match(/<math/g)).toHaveLength(1000);
        expect((await exportEquations('pdf-html', ...paper)).match(/class="math-svg"/g)).toHaveLength(1000);
    }, 60_000);

    // DOMPurify's MathML profile drops <none>, which holds an empty script's place.
    test('a prescript keeps its empty slot', async () => {
        const html = await exportEquations('html', {
            mathml: writeMathml([{ kind: 'scripts', base: x, sub: [{ kind: 'number', text: '1' }], pre: true }]),
        });
        expect(html).toContain(
            '<mmultiscripts><mi>x</mi><mprescripts></mprescripts><mn>1</mn><none></none></mmultiscripts>',
        );
    });

    test('a forged or malformed stored string never reaches the HTML', async () => {
        const html = await exportEquations(
            'html',
            { mathml: `${MATH}<mi onclick="alert(1)">x</mi><script>alert(2)</script></math>` },
            { mathml: `${MATH}<mi>x</mi>` },
        );
        expect(html).toContain(
            `<p><span class="equation">${MATH}<mi>x</mi></math></span><span class="equation">${MATH}</math></span><br></p>`,
        );
        expect(html).not.toContain('alert');
    });
});

describe('doc export — table column widths', () => {
    // As a drag in the editor leaves them: every cell of a column holds its width.
    const cell = (text: string, width: number): JSONContent => ({
        type: 'tableCell',
        attrs: { colwidth: [width] },
        content: [paragraph(text)],
    });
    const row = (): JSONContent => ({ type: 'tableRow', content: [cell('a', 300), cell('b', 150), cell('c', 120)] });
    const resized = () => seededDoc({ type: 'doc', content: [{ type: 'table', content: [row(), row()] }] });

    test.each(['html', 'pdf-html'] as const)('%s draws each column at its width', async (format) => {
        const { data } = await renderEigendocExport(resized(), format, 'Report.eigendoc', async () => [], undefined);
        const { document } = new JSDOM(new TextDecoder().decode(data)).window;
        const cols = [...document.querySelectorAll<HTMLTableColElement>('table col')];
        expect(cols.map((col) => col.style.width)).toEqual(['300px', '150px', '120px']);
        expect(document.querySelector('table')?.style.width).toBe('570px');
    });

    test('a docx export imports back with the same widths', async () => {
        const { data } = await renderEigendocExport(resized(), 'docx', 'Report.eigendoc', async () => [], undefined);
        const { json } = docxToPmJson(Buffer.from(data));
        const widths = json.content?.[0]?.content?.flatMap((tableRow) =>
            (tableRow.content ?? []).map((node) => node.attrs?.['colwidth']),
        );
        expect(widths).toEqual([[300], [150], [120], [300], [150], [120]]);
    });
});

describe('doc export — cell borders', () => {
    const bordered = () =>
        seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'table',
                    content: [
                        {
                            type: 'tableRow',
                            content: [
                                {
                                    type: 'tableCell',
                                    attrs: { borderTop: '2px dashed #ff0000', borderLeft: 'none', borderRight: 'red' },
                                    content: [paragraph('a')],
                                },
                            ],
                        },
                    ],
                },
            ],
        });

    // The sanitizer keeps a cell's style, so its own sides draw over eigen-prose.css's grey; a forged side draws the grey.
    test.each(['html', 'pdf-html'] as const)('%s draws a cell its own sides', async (format) => {
        const { data } = await renderEigendocExport(bordered(), format, 'Report.eigendoc', async () => [], undefined);
        const { document } = new JSDOM(new TextDecoder().decode(data)).window;
        const cell = document.querySelector<HTMLTableCellElement>('td');
        expect(cell?.getAttribute('style')).toBe('border-top: 2px dashed #ff0000; border-left: none');
    });
});

describe('doc export — whitespace', () => {
    test.each(['html', 'pdf-html'] as const)(
        '%s keeps repeated spaces and prints no whitespace around the body',
        async (format) => {
            const doc = seededDoc({ type: 'doc', content: [paragraph('a  b')] });
            const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
            const html = new TextDecoder().decode(data);
            expect(html).toContain('<p>a  b</p>');
            expect(html).toMatch(/<article class="eigen-prose tiptap eigen-doc"><p>/);
            expect(html).toContain('</p></article>');
        },
    );
});

describe('doc export — caps', () => {
    const caps = (text: string, value: string, fontFamily: string | null = null, italic = false): JSONContent => ({
        type: 'text',
        text,
        marks: [{ type: 'textStyle', attrs: { caps: value, fontFamily } }, ...(italic ? [{ type: 'italic' }] : [])],
    });

    async function exportBody(format: 'html' | 'pdf-html', content: JSONContent[]): Promise<string> {
        const { data } = await renderEigendocExport(
            seededDoc({ type: 'doc', content }),
            format,
            'Report.eigendoc',
            async () => [],
            undefined,
        );
        return new TextDecoder().decode(data);
    }

    test.each(['html', 'pdf-html'] as const)('%s draws all caps in CSS over the letters as typed', async (format) => {
        expect(await exportBody(format, [{ type: 'paragraph', content: [caps('Title', 'all')] }])).toContain(
            '<p><span style="text-transform: uppercase">Title</span></p>',
        );
    });

    // The schema's renderHTML reads the stored size, so a forged one draws nothing.
    test.each(['html', 'pdf-html'] as const)(
        '%s draws a font size in pt, and a forged one not at all',
        async (format) => {
            const sized = (text: string, fontSize: unknown) => ({
                type: 'text',
                text,
                marks: [{ type: 'textStyle', attrs: { fontSize } }],
            });
            const html = await exportBody(format, [
                { type: 'paragraph', content: [sized('Big', 14), sized(' forged', '1pt; position: fixed')] },
            ]);
            expect(html).toContain('<p><span style="font-size: 14pt">Big</span><span> forged</span></p>');
        },
    );

    test('html draws small caps in CSS over the letters as typed', async () => {
        expect(await exportBody('html', [{ type: 'paragraph', content: [caps(' Name', 'small')] }])).toContain(
            '<p><span style="font-variant-caps: small-caps"> Name</span></p>',
        );
    });

    // WeasyPrint draws small caps only from a font's smcp glyphs, which only upright Source Serif 4 has.
    test('the pdf draws small caps in a font without them as smaller capitals', async () => {
        const small = (text: string) => `<span style="font-size: 0.7em">${text}</span>`;
        const html = await exportBody('pdf-html', [
            { type: 'paragraph', content: [caps('Mac Straße é 1 👍🏽x', 'small')] },
            { type: 'paragraph', content: [caps('Serif', 'small', 'Source Serif 4', true)] },
            {
                type: 'blockquote',
                content: [
                    { type: 'paragraph', content: [caps('Quote', 'small', 'Source Serif 4')] },
                    { type: 'paragraph', content: [caps('Mono', 'small', 'JetBrains Mono')] },
                    { type: 'paragraph', content: [caps('Body', 'small')] },
                ],
            },
        ]);

        expect(html).toContain(
            `<p><span style="font-variant-caps: small-caps">M${small('AC')} S${small('TRASSE')} ${small('É')} 1 👍🏽${small('X')}</span></p>`,
        );
        expect(html).toContain(`S${small('ERIF')}`);
        expect(html).toContain(`Q${small('UOTE')}`);
        expect(html).toContain(`M${small('ONO')}`);
        expect(html).toContain(`B${small('ODY')}`);
    });

    // Heading 6 draws italic, and an italic mark in it upright.
    test("the pdf reads Heading 6's italic, an italic mark in it upright", async () => {
        const html = await exportBody('pdf-html', [
            {
                type: 'heading',
                attrs: { level: 6 },
                content: [caps('Plain', 'small', 'Source Serif 4'), caps(' Marked', 'small', 'Source Serif 4', true)],
            },
        ]);
        expect(html).toContain('P<span style="font-size: 0.7em">LAIN</span>');
        expect(html).toContain('<em> Marked</em>');
    });

    test('the pdf keeps upright Source Serif 4 small caps as typed', async () => {
        const html = await exportBody('pdf-html', [
            { type: 'paragraph', content: [caps('Serif', 'small', 'Source Serif 4')] },
        ]);
        expect(html).toContain(
            `<p><span style="font-family: 'Source Serif 4', serif; font-variant-caps: small-caps">Serif</span></p>`,
        );
    });
});

// The docx writer's rule (doc/docx/to-docx.test.ts), so a link to another Eigen file works in every format.
describe('doc export — links', () => {
    async function hrefsOf(format: 'html' | 'pdf-html', publicOrigin?: string): Promise<string[]> {
        const linked = (href: string) => ({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] });
        const doc = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        linked('/drive/x?id=1'),
                        linked('//host/x'),
                        linked('https://a.example/'),
                        linked('#frag'),
                    ],
                },
            ],
        });
        const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], publicOrigin);
        return [...new TextDecoder().decode(data).matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1] ?? '');
    }

    test.each(['html', 'pdf-html'] as const)(
        '%s prefixes a root-relative href with the public origin',
        async (format) => {
            expect(await hrefsOf(format, 'https://eigen.example')).toEqual([
                'https://eigen.example/drive/x?id=1',
                'https://host/x',
                'https://a.example/',
                '#frag',
            ]);
        },
    );

    // The editor draws a link's own color: its <a> holds the colored span, so .eigen-prose a's color has nothing to draw.
    test.each(['html', 'pdf-html'] as const)('%s nests a colored link as the editor does', async (format) => {
        const href = 'https://a.example/';
        const doc = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'plain', marks: [{ type: 'link', attrs: { href } }] },
                        {
                            type: 'text',
                            text: 'pink',
                            marks: [
                                { type: 'textStyle', attrs: { color: '#ff00aa' } },
                                { type: 'underline' },
                                { type: 'link', attrs: { href } },
                            ],
                        },
                    ],
                },
            ],
        });
        const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
        const { document } = new JSDOM(new TextDecoder().decode(data)).window;
        expect([...document.querySelectorAll('article p > *')].map((node) => node.outerHTML)).toEqual([
            `<a target="_blank" rel="noopener noreferrer" href="${href}">plain</a>`,
            `<a target="_blank" rel="noopener noreferrer" href="${href}"><span style="color: #ff00aa"><u>pink</u></span></a>`,
        ]);
    });

    test('the html download opens a link in a new tab, as the editor does', async () => {
        const doc = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: 'https://a.example/' } }] },
                    ],
                },
            ],
        });
        const { data } = await renderEigendocExport(doc, 'html', 'Report.eigendoc', async () => [], undefined);
        const { document } = new JSDOM(new TextDecoder().decode(data)).window;
        expect(document.querySelector('article a')?.getAttribute('target')).toBe('_blank');
    });

    test('a root-relative href stays relative without a public origin', async () => {
        expect(await hrefsOf('html')).toEqual(['/drive/x?id=1', 'https://host/x', 'https://a.example/', '#frag']);
    });
});

// A docx sizes an SVG figure as the HTML export draws it: CSS at 96 dpi, where sharp reads physical units at 72.
describe('doc export — docx SVG size', () => {
    const svg = (attrs: string) =>
        `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="100%" height="100%" fill="#2563eb"/></svg>`;

    async function extentPx(attrs: string): Promise<[number, number]> {
        const doc = seededDoc({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'figure', attrs: { mediaName: 'd.svg' } }] }],
        });
        const media = [{ name: 'd.svg', contentType: 'image/svg+xml', data: toTransferableText(svg(attrs)) }];
        const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', async () => media, undefined);
        const xml = new TextDecoder().decode(openZip(new Uint8Array(data)).read('word/document.xml'));
        const [, cx = '0', cy = '0'] = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/) ?? [];
        return [Number(cx) / 9525, Number(cy) / 9525];
    }

    test.each([
        ['width="4in" height="2in"', 384, 192],
        ['width="10cm" height="5cm"', 377.95, 188.98],
        ['width="100mm" height="50mm"', 377.95, 188.98],
        ['width="200pt" height="100pt"', 266.67, 133.33],
        ['width="20pc" height="10pc"', 320, 160],
        ['width="4in" viewBox="0 0 200 100"', 384, 192],
        ['height="2in" viewBox="0 0 200 100"', 384, 192],
        ['width="4in" height="100"', 384, 100],
        ['width="300" height="150"', 300, 150],
        ['width="300px" height="150px"', 300, 150],
        ['viewBox="0 0 300 150"', 300, 150],
    ])('%s draws at %d by %d px', async (attrs, width, height) => {
        const [cx, cy] = await extentPx(attrs);
        expect(Math.abs(cx - width)).toBeLessThanOrEqual(1);
        expect(Math.abs(cy - height)).toBeLessThanOrEqual(1);
    });
});

// A figure pasted with a data: src has no media file; the docx encodes it as it does one.
describe('doc export — docx data: figures', () => {
    const dataUri = (type: string, bytes: Buffer | string) =>
        `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

    async function docxOf(...srcs: string[]) {
        const doc = seededDoc({
            type: 'doc',
            content: srcs.map((src) => ({ type: 'paragraph', content: [{ type: 'figure', attrs: { src } }] })),
        });
        const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', async () => [], undefined);
        const zip = openZip(new Uint8Array(data));
        return { zip, parts: zip.names().filter((name) => name.startsWith('word/media/')) };
    }

    const red = (width: number, height: number, alpha = 1) =>
        sharp({ create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha } } });

    test('a data: PNG writes its PNG part at its own size, and one shown twice is one part', async () => {
        const src = dataUri('image/png', await red(80, 50).png().toBuffer());
        const { zip, parts } = await docxOf(src, src);
        expect(parts).toEqual(['word/media/image1.png']);
        const { format, width, height } = await sharp(zip.read('word/media/image1.png')).metadata();
        expect([format, width, height]).toEqual(['png', 80, 50]);
    });

    test('a data: JPEG is re-encoded: its EXIF, GPS included, stays out, and past 2560 px it shrinks', async () => {
        const photo = await red(3000, 1000)
            .flatten()
            .jpeg()
            .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 5/1 0/1' } })
            .toBuffer();
        const { zip, parts } = await docxOf(dataUri('image/jpeg', photo));
        expect(parts).toEqual(['word/media/image1.jpeg']);
        const { format, width, height, exif } = await sharp(zip.read('word/media/image1.jpeg')).metadata();
        expect([format, width, height, exif]).toEqual(['jpeg', 2560, 853, undefined]);
    });

    test('a transparent data: WebP takes PNG', async () => {
        const { parts } = await docxOf(dataUri('image/webp', await red(40, 40, 0).webp().toBuffer()));
        expect(parts).toEqual(['word/media/image1.png']);
    });

    // A web copy names its charset, and a media type is case-insensitive.
    test.each(['image/svg+xml', 'image/svg+xml;charset=utf-8', 'Image/SVG+XML'])(
        'a data: SVG typed %s is sanitized and draws its PNG fallback',
        async (type) => {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20"/><image href="https://example.com/beacon.png"/></svg>`;
            const { zip, parts } = await docxOf(dataUri(type, svg));
            expect(parts).toEqual(['word/media/image1.png', 'word/media/image1.svg']);
            expect(new TextDecoder().decode(zip.read('word/media/image1.svg'))).not.toContain('beacon');
        },
    );

    test('a data: src that is not base64 or not an image writes nothing', async () => {
        const { parts } = await docxOf('data:image/svg+xml,%3Csvg%2F%3E', dataUri('image/png', 'not a png'));
        expect(parts).toEqual([]);
    });
});

// A pasted data: src carries whatever the source wrote into it, such as a phone photo's GPS position, so the HTML and
// the PDF draw it re-encoded, as the docx does.
describe('doc export — HTML data: figures', () => {
    const dataUri = (type: string, bytes: Buffer | string) =>
        `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

    async function imgSrcsOf(format: 'html' | 'pdf-html', ...srcs: string[]): Promise<string[]> {
        const doc = seededDoc({
            type: 'doc',
            content: srcs.map((src) => ({ type: 'paragraph', content: [{ type: 'figure', attrs: { src } }] })),
        });
        const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
        return [...new TextDecoder().decode(data).matchAll(/<img src="([^"]*)"/g)].map(([, src]) => src ?? '');
    }

    test.each(['html', 'pdf-html'] as const)('%s draws a data: JPEG without its EXIF', async (format) => {
        const photo = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c00' } })
            .jpeg()
            .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 5/1 0/1' } })
            .toBuffer();
        expect((await sharp(photo).metadata()).exif).toBeDefined();
        const [src] = await imgSrcsOf(format, dataUri('image/jpeg', photo));
        const drawn = Buffer.from(src?.split(',')[1] ?? '', 'base64');
        const { format: type, width, exif } = await sharp(drawn).metadata();
        expect([type, width, exif]).toEqual(['jpeg', 40, undefined]);
    });

    test('a data: src no image decodes from draws nothing, and a percent-encoded SVG draws as it is', async () => {
        const svg = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
        expect(await imgSrcsOf('html', dataUri('image/png', 'not a png'), svg)).toEqual([svg]);
    });

    // Only a base64 src is decoded and re-encoded, so a percent-encoded raster would carry its EXIF out as it was pasted.
    test.each(['html', 'pdf-html'] as const)(
        '%s draws nothing for a data: raster that is not base64',
        async (format) => {
            const jpeg = 'data:image/jpeg,%FF%D8%FF%E1%00%10Exif%00%00';
            const svg = 'data:IMAGE/SVG+XML;charset=utf-8,%3Csvg%2F%3E';
            expect(await imgSrcsOf(format, jpeg, 'data:,plain', svg)).toEqual([svg]);
        },
    );
});

// Worker.terminate() does not stop libvips, so only sharp's own timeout frees the one transform slot from a filter
// librsvg grinds through for minutes.
describe('doc export — docx SVG fallback timeout', () => {
    const slow = `<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="2560"><filter id="f" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.9" numOctaves="10"/></filter><rect width="2560" height="2560" filter="url(#f)"/></svg>`;
    const fast = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

    const figure = (mediaName: string): JSONContent => ({
        type: 'paragraph',
        content: [{ type: 'figure', attrs: { mediaName } }],
    });

    // Untimed, the slow one renders in seconds and gets a PNG, so its absence proves the timeout fired; a wall-clock
    // bound fails on a loaded CI runner, where the uninterruptible librsvg pass alone outlasts it.
    test('an SVG that outlasts the timeout leaves the docx, and the next one is still drawn', async () => {
        const original = { ...thumbnailTimeout };
        mock.module('../../lib/shared/thumbnail-timeout', () => ({ THUMBNAIL_TIMEOUT_SECONDS: 1 }));
        try {
            const media = [
                { name: 'slow.svg', contentType: 'image/svg+xml', data: toTransferableText(slow) },
                { name: 'fast.svg', contentType: 'image/svg+xml', data: toTransferableText(fast) },
            ];
            const doc = seededDoc({ type: 'doc', content: [figure('slow.svg'), figure('fast.svg')] });
            const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', async () => media, undefined);
            const zip = openZip(new Uint8Array(data));
            expect(zip.names().filter((name) => name.startsWith('word/media/'))).toEqual([
                'word/media/image1.png',
                'word/media/image1.svg',
            ]);
            expect(new TextDecoder().decode(zip.read('word/media/image1.svg'))).toContain('width="10"');
        } finally {
            mock.module('../../lib/shared/thumbnail-timeout', () => original);
        }
    }, 30_000);
});

function listItem(text: string, ...nested: JSONContent[]): JSONContent {
    return { type: 'listItem', content: [paragraph(text), ...nested] };
}

function orderedList(attrs: { start?: number; type?: string }, ...items: JSONContent[]): JSONContent {
    return { type: 'orderedList', attrs, content: items };
}

async function pdfHtml(...content: JSONContent[]): Promise<string> {
    const doc = seededDoc({ type: 'doc', content });
    const { data } = await renderEigendocExport(doc, 'pdf-html', 'Report.eigendoc', async () => [], undefined);
    return new TextDecoder().decode(data);
}

// WeasyPrint applies <ol start> only as a presentational hint, which the renderer leaves off, so the list's first number
// is a counter-reset on the ol itself.
describe('doc export — ordered lists', () => {
    test.each(['html', 'pdf-html'] as const)(
        '%s resets the counter on an ol that does not start at 1',
        async (format) => {
            const doc = seededDoc({
                type: 'doc',
                content: [orderedList({ start: 3 }, listItem('a')), orderedList({ start: 1 }, listItem('b'))],
            });
            const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
            const html = new TextDecoder().decode(data);
            expect(html).toContain('<ol start="3" style="counter-reset: list-item 2">');
            expect(html).not.toContain('list-item 0');
            expect(html.match(/counter-reset: list-item/g)).toHaveLength(1);
        },
    );

    test('a nested ol resets its own counter', async () => {
        const html = await pdfHtml(orderedList({ start: 3 }, listItem('a', orderedList({ start: 5 }, listItem('b')))));
        expect(html).toContain('list-item 2">');
        expect(html).toContain('list-item 4">');
    });

    test.each([
        ['a', 'lower-alpha'],
        ['A', 'upper-alpha'],
        ['i', 'lower-roman'],
        ['I', 'upper-roman'],
    ])('an ol of type %s draws %s on itself', async (type, style) => {
        const html = await pdfHtml(orderedList({ start: 2, type }, listItem('b')));
        expect(html).toContain(
            `<ol start="2" type="${type}" style="counter-reset: list-item 1; list-style-type: ${style}">`,
        );
    });

    // A list set to decimal keeps it nested, over eigen-prose.css's numbering by depth; an unknown type is untyped.
    test('a decimal ol draws decimal on itself, an untyped one and an unknown type no marker style', async () => {
        const html = await pdfHtml(
            orderedList({ type: '1' }, listItem('a')),
            orderedList({ type: 'x' }, listItem('b')),
            orderedList({}, listItem('c')),
        );
        expect(html).toContain('<ol type="1" style="list-style-type: decimal">');
        expect(html.match(/<ol>/g)).toHaveLength(2);
    });
});

const weasyPrint = await isWeasyPrintAvailable();
const launcher = Bun.which('weasyprint');
const python = launcher ? shebangPython(await Bun.file(launcher).slice(0, 512).text()) : null;

// A Python script's whole output once it has exited. WeasyPrint hits a SIGSEGV now and then while renders run side by
// side, which the export renders once more (weasyprint.ts), so this does too; any other failure throws its stderr.
async function pythonOutput(args: string[], input: string): Promise<string> {
    if (python === null) throw new Error('no python behind the weasyprint launcher');
    for (let attempt = 0; ; attempt++) {
        const proc = Bun.spawn([python, '-I', ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
        proc.stdin.write(input);
        await proc.stdin.end();
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (code === 0) return stdout;
        if (proc.signalCode !== 'SIGSEGV' || attempt > 0)
            throw new Error(`python exited with ${proc.signalCode ?? code}: ${stderr}`);
    }
}

// What `line` prints of each box WeasyPrint lays out for the pages the PDF is written from, `tag` its element's name.
async function laidOut(html: string, line: string): Promise<string[]> {
    const script = `
import sys, weasyprint
def walk(box):
    yield box
    for child in getattr(box, 'children', None) or []:
        yield from walk(child)
for page in weasyprint.HTML(string=sys.stdin.read()).render().pages:
    for box in walk(page._page_box):
        tag = str(getattr(box, 'element_tag', '')).split('}')[-1]
        ${line}
`;
    return (await pythonOutput(['-c', script], html)).trim().split('\n');
}

(weasyPrint && python !== null ? describe : describe.skip)('doc export — positioned figures (WeasyPrint)', () => {
    // WeasyPrint draws an absolute box from its paragraph's padding box, in front of the text or behind it.
    test.each(['front', 'behind'])(
        'a %s image prints at its offsets from its paragraph',
        async (layout) => {
            const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#888' } })
                .png()
                .toBuffer();
            const figure = {
                type: 'figure',
                attrs: {
                    src: `data:image/png;base64,${png.toString('base64')}`,
                    width: 200,
                    layout,
                    offsetX: -30,
                    offsetY: 24,
                },
            };
            const html = await pdfHtml(
                { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
                { type: 'paragraph', content: [figure, { type: 'text', text: 'Anchor' }] },
            );
            const boxes = await laidOut(
                html,
                "if tag == 'img' or tag == 'p' and type(box).__name__ == 'BlockBox': print(tag, box.padding_box_x(), box.padding_box_y(), box.width)",
            );
            const [, anchor, image] = boxes.map((line) => line.split(' '));
            expect(image?.[0]).toBe('img');
            expect(Number(image?.[1])).toBeCloseTo(Number(anchor?.[1]) - 30, 3);
            expect(Number(image?.[2])).toBeCloseTo(Number(anchor?.[2]) + 24, 3);
            expect(Number(image?.[3])).toBeCloseTo(200, 3);
        },
        60_000,
    );
});

(weasyPrint && python !== null ? describe : describe.skip)('doc export — tables across pages (WeasyPrint)', () => {
    // As Word and Google Docs print one, a table taller than what is left of the page starts there and goes on over the
    // next, rather than leaving the page half empty. Word's "Allow row to break across pages" is on by default, so a row
    // does the same.
    const intro = Array.from({ length: 10 }, (_, i) => paragraph(`Intro ${i + 1}`));
    const cell = (...texts: string[]) => ({ type: 'tableCell', content: texts.map((text) => paragraph(text)) });
    const firstPageTexts = async (rows: JSONContent[]) => {
        const html = await pdfHtml(...intro, { type: 'table', content: rows });
        const texts = await laidOut(html, "if type(box).__name__ == 'TextBox': print(id(page), box.text)");
        const firstPage = texts[0]?.split(' ')[0];
        return texts
            .filter((line) => line.startsWith(`${firstPage} `))
            .map((line) => line.slice(line.indexOf(' ') + 1));
    };

    test('a 60-row table after half a page starts on the first page', async () => {
        const rows = Array.from({ length: 60 }, (_, i) => ({ type: 'tableRow', content: [cell(`Row ${i + 1}`)] }));
        const onFirstPage = await firstPageTexts(rows);
        expect(onFirstPage).toContain('Intro 1');
        expect(onFirstPage).toContain('Row 1');
    }, 60_000);

    test('a row taller than what is left of the page starts on it and goes on over the next', async () => {
        const lines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`);
        const onFirstPage = await firstPageTexts([{ type: 'tableRow', content: [cell(...lines)] }]);
        expect(onFirstPage).toContain('Intro 1');
        expect(onFirstPage).toContain('Line 1');
        expect(onFirstPage).not.toContain('Line 60');
    }, 60_000);
});

(weasyPrint && python !== null ? describe : describe.skip)('doc export — ordered list numbers (WeasyPrint)', () => {
    test('a start, a nested start and the letter and roman types are drawn', async () => {
        const html = await pdfHtml(
            orderedList(
                { start: 3 },
                listItem('a', orderedList({ start: 5, type: 'i' }, listItem('b'))),
                listItem('c'),
            ),
            orderedList({ start: 2, type: 'a' }, listItem('d'), listItem('e')),
            orderedList({ type: 'I' }, listItem('f')),
        );
        const markers = await laidOut(html, "if 'marker' in tag and hasattr(box, 'text'): print(box.text.strip())");
        expect(markers).toEqual(['3.', 'v.', '4.', 'b.', 'c.', 'I.']);
    }, 60_000);

    // WeasyPrint gives a formatting context its whole width and moves it below a float it doesn't fit beside
    // (avoid_collisions, layout/float.py), where Chrome narrows it: the PDF's list starts below the figure, never
    // under it, where the editor's flows beside it (EXPORT.md).
    test('a list after a left-wrapped figure starts below it, its markers clear of it', async () => {
        const png = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#888' } })
            .png()
            .toBuffer();
        const figure = {
            type: 'figure',
            attrs: { src: `data:image/png;base64,${png.toString('base64')}`, width: 200, layout: 'wrap-left' },
        };
        const html = await pdfHtml(
            { type: 'paragraph', content: [figure, { type: 'text', text: 'beside' }] },
            orderedList({}, listItem('one', orderedList({}, listItem('a'))), listItem('two')),
        );
        const [image = '', ...markers] = await laidOut(
            html,
            "if tag == 'img': print(box.position_y + box.height)\n        if 'marker' in tag and type(box).__name__ == 'TextBox': print(box.position_y)",
        );
        expect(markers).toHaveLength(3);
        for (const top of markers) expect(Number(top)).toBeGreaterThanOrEqual(Number(image));
    }, 60_000);

    // A Docs list is its own formatting context, which keeps its items' margins in: each item still follows the one
    // above at one step, out of a nested list too, and the list's own margin is all there is after it.
    // A Normal of another size scales the items' em margins with it.
    test.each([11, 13])(
        'nested lists step evenly from item to item, out of a nested list too, at a %i pt Normal',
        async (size) => {
            const sized = async (...content: JSONContent[]) => {
                const doc = seededDoc({ type: 'doc', content });
                doc.getMap(STYLE_ROOT).set('size', size);
                const { data } = await renderEigendocExport(
                    doc,
                    'pdf-html',
                    'Report.eigendoc',
                    async () => [],
                    undefined,
                );
                return new TextDecoder().decode(data);
            };
            const html = await sized(
                orderedList(
                    {},
                    listItem(
                        'one',
                        orderedList({}, listItem('a', orderedList({}, listItem('i'), listItem('ii'))), listItem('b')),
                    ),
                    listItem('two'),
                ),
                paragraph('after'),
            );
            const lines = async (doc: string) => [
                ...new Set(
                    (
                        await laidOut(
                            doc,
                            "if type(box).__name__ == 'TextBox' and box.text.strip(): print(box.position_y)",
                        )
                    ).map((top) => Math.round(Number(top) * 100) / 100),
                ),
            ];
            const [one = 0, a = 0, i = 0, ii = 0, b = 0, two = 0, after = 0] = await lines(html);
            // A nested list opens 0.2em below its item; out of one, the step is an item's, where it was 5 px more.
            expect(a - one).toBeCloseTo(i - a, 1);
            expect(b - ii).toBeCloseTo(ii - i, 1);
            expect(two - b).toBeCloseTo(ii - i, 1);
            const [item = 0, next = 0] = await lines(await sized(orderedList({}, listItem('x')), paragraph('y')));
            expect(after - two).toBeCloseTo(next - item, 0);
        },
        60_000,
    );
});

(weasyPrint && python !== null ? describe : describe.skip)('doc export — equations (WeasyPrint)', () => {
    // MathJax breaks no equation into lines, so one wider than the column scales down to it.
    test('an equation wider than the column fits it, in its own proportions', async () => {
        const terms = (count: number): MathRow =>
            Array.from({ length: count }, (_, i) =>
                i % 2 ? { kind: 'operator', text: '+' } : { kind: 'identifier', text: 'x' },
            );
        const html = await pdfHtml({
            type: 'paragraph',
            content: [
                equation(writeMathml(terms(121)), true),
                { type: 'text', text: 'and ' },
                equation(writeMathml(terms(81))),
            ],
        });
        const boxes = await laidOut(html, "if tag in ('article', 'svg'): print(tag, box.width, box.height)");
        const [column, ...svgs] = boxes.map((box) => box.split(' ').slice(1).map(Number));
        const drawn = [...html.matchAll(/<svg [^>]*width="([\d.]+)ex" height="([\d.]+)ex"/g)];

        expect(svgs).toHaveLength(2);
        svgs.forEach(([width, height], i) => {
            expect(width).toBeCloseTo(column[0], 1);
            expect(width / height).toBeCloseTo(Number(drawn[i][1]) / Number(drawn[i][2]), 0);
        });
    }, 60_000);
});

// D16: an unformatted paragraph draws the doc's Normal, and a paragraph's own format still wins. The line is measured
// as drawn: WeasyPrint 68 stores a computed line height as ('NUMBER', x) and 70 as a float.
(weasyPrint && python !== null ? describe : describe.skip)('doc export — the Normal (WeasyPrint)', () => {
    test('an unformatted paragraph draws in the Normal: its font, size, line and spacing', async () => {
        const { data } = await renderEigendocExport(
            styledDoc({
                type: 'doc',
                content: [
                    paragraph('a'),
                    paragraph('b'),
                    { type: 'paragraph', attrs: { spaceBefore: 0 }, content: [{ type: 'text', text: 'c' }] },
                ],
            }),
            'pdf-html',
            'Report.eigendoc',
            async () => [],
            undefined,
        );
        const boxes = await laidOut(
            new TextDecoder().decode(data),
            "if tag == 'p' and type(box).__name__ == 'BlockBox': print(box.style['font_family'][0], box.style['font_size'], round(box.height / box.style['font_size'], 2), float(box.padding_top), float(box.margin_bottom))",
        );
        expect(boxes).toEqual([
            'Source Serif 4 16.0 1.21 8.0 0.0',
            'Source Serif 4 16.0 1.21 8.0 0.0',
            'Source Serif 4 16.0 1.21 0.0 0.0',
        ]);
    }, 60_000);
});

// The bands sit in .page, which carries the Normal, so a running header inherits it in its margin box.
(weasyPrint && python !== null ? describe : describe.skip)('doc export — the Normal in the bands (WeasyPrint)', () => {
    test("a 12 pt Times Normal draws in the PDF's header as in its body", async () => {
        const doc = styledDoc({ type: 'doc', content: [paragraph('Body text')] });
        seedBand(doc, 'header', paragraph('Acme header'));
        const html = await exported('pdf-html', doc);
        const page = html.slice(html.indexOf('<div class="page">'));
        expect(page.indexOf('class="band-header"')).toBeGreaterThan(-1);
        const boxes = await laidOut(
            html,
            "if tag == 'p' and type(box).__name__ == 'BlockBox': print(box.style['font_family'][0], box.style['font_size'], ''.join(getattr(b, 'text', '') for b in walk(box)).strip())",
        );
        // The page's own boxes first, then its margin boxes.
        expect(boxes).toEqual(['Source Serif 4 16.0 Body text', 'Source Serif 4 16.0 Acme header']);
    }, 60_000);
});

// D13: a paragraph's own spacing and indents, as Word and Google Docs draw them.
(weasyPrint && python !== null ? describe : describe.skip)('doc export — paragraph format (WeasyPrint)', () => {
    const formatted = (attrs: Record<string, unknown>, text = 'x'): JSONContent => ({
        type: 'paragraph',
        attrs,
        content: [{ type: 'text', text }],
    });
    // The space between each paragraph's text and the next one's, in pt.
    const gaps = async (...content: JSONContent[]) => {
        const boxes = await laidOut(
            await pdfHtml(...content),
            "if tag in ('p', 'h2') and type(box).__name__ == 'BlockBox': print(box.content_box_y(), box.height)",
        );
        const spans = boxes.map((box) => box.split(' ').map(Number));
        return spans.slice(1).map(([top], i) => {
            const [previousTop, previousHeight] = spans[i];
            return Math.round((top - previousTop - previousHeight) * 0.75 * 100) / 100;
        });
    };

    test("paragraphs part by the space after the one above alone: 11 pt, none at 0, Eigen's look unchanged", async () => {
        expect(
            await gaps(
                paragraph('a'),
                paragraph('b'),
                formatted({ spaceAfter: 0 }),
                formatted({ spaceAfter: 0 }),
                paragraph('c'),
            ),
        ).toEqual([11, 11, 0, 0]);
    }, 60_000);

    // CSS margins collapse to the larger; Word and Google Docs add the two.
    test('a space before adds to the space after the paragraph above', async () => {
        expect(
            await gaps(
                paragraph('a'),
                formatted({ spaceBefore: 12 }),
                formatted({ spaceAfter: 0 }),
                formatted({ spaceBefore: 6 }),
            ),
        ).toEqual([23, 11, 6]);
        // A heading's own space before replaces its style's.
        const heading = {
            type: 'heading',
            attrs: { level: 2, spaceBefore: 6 },
            content: [{ type: 'text', text: 'h' }],
        };
        expect(await gaps(paragraph('a'), heading)).toEqual([17]);
    }, 60_000);

    // A list owns the spacing of its items, as the docx writes it.
    test("in a list item a stored space before or after draws nothing of the list's", async () => {
        const item = (attrs: Record<string, unknown>) => ({
            type: 'listItem',
            content: [formatted(attrs)],
        });
        const plain = await gaps({ type: 'bulletList', content: [item({}), item({}), item({})] });
        const stored = await gaps({
            type: 'bulletList',
            content: [item({ spaceAfter: 40 }), item({ spaceBefore: 40 }), item({})],
        });
        expect(stored).toEqual(plain);
    }, 60_000);

    // Word's w:left and w:hanging, Google's Left and Hanging: the body lines at Left, the first line hanging out of it.
    test('a hanging indent draws the first line left of the body lines, which stand at the left indent', async () => {
        const cm = (value: number) => (value / 2.54) * 72;
        const html = await pdfHtml(formatted({ indentLeft: cm(2), indentFirstLine: -cm(1) }, 'word '.repeat(60)));
        const lines = await laidOut(
            html,
            "if tag == 'article': print(box.content_box_x())\n        if type(box).__name__ == 'LineBox' and box.children: print(box.children[0].position_x)",
        );
        const [column, first, second] = lines.map(Number);
        expect(Math.round(((first - column) * 0.75 * 2.54) / 0.72) / 100).toBe(1);
        expect(Math.round(((second - column) * 0.75 * 2.54) / 0.72) / 100).toBe(2);
    }, 60_000);
});

// A doc with a header and a footer holding page numbers, page 1's own header when it differs, and `pages` pages.
function bandedDoc(pages: number, differentFirstPage: boolean): Y.Doc {
    const body = Array.from({ length: pages }, (_, index) => [
        ...(index > 0 ? [{ type: 'pageBreak' }] : []),
        paragraph(`Body ${index + 1}`),
    ]).flat();
    const doc = seededDoc({ type: 'doc', content: body });
    const number = (kind: 'page' | 'pages') => ({ type: 'pageNumber', attrs: { kind } });
    seedBand(doc, 'header', paragraph('Acme header'));
    seedBand(doc, 'footer', {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Page ' }, number('page'), { type: 'text', text: ' of ' }, number('pages')],
    });
    seedBand(doc, 'headerFirst', paragraph('Letterhead'));
    doc.getMap(PAGE_ROOT).set('differentFirstPage', differentFirstPage);
    return doc;
}

async function exported(format: 'html' | 'pdf-html', doc: Y.Doc): Promise<string> {
    const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', async () => [], undefined);
    return new TextDecoder().decode(data);
}

describe('doc export — headers and footers', () => {
    // element() takes the running element placed on the page or the last one before it, so a footer placed after the
    // body would print on the last page only.
    test('the PDF places the bands before the body as running elements, shown in the margin boxes', async () => {
        const html = await exported('pdf-html', bandedDoc(2, false));
        const body = html.slice(html.indexOf('<body>'));
        expect(body.indexOf('Acme header')).toBeLessThan(body.indexOf('Body 1'));
        expect(body.indexOf('Page ')).toBeLessThan(body.indexOf('Body 1'));
        expect(body).not.toContain('Letterhead');
        expect(body).not.toContain('element(');

        const css = await exportStyle('pdf-html', bandedDoc(2, false));
        expect(css).toContain('.band-header { position: running(header); }');
        expect(css).toContain('.band-footer { position: running(footer); }');
        expect(css).toMatch(/@top-center \{ content: element\(header\);[^}]*padding-top: 12\.7mm;/);
        expect(css).toMatch(/@bottom-center \{ content: element\(footer\);[^}]*padding-bottom: 12\.7mm;/);
        expect(css).not.toContain('@page :first');
    });

    test("with page 1 different, the PDF's first page takes the first-page bands", async () => {
        const html = await exported('pdf-html', bandedDoc(2, true));
        expect(html.indexOf('Letterhead')).toBeLessThan(html.indexOf('Body 1'));
        const css = await exportStyle('pdf-html', bandedDoc(2, true));
        expect(css).toContain(
            '@page :first { @top-center { content: element(headerFirst); } @bottom-center { content: element(footerFirst); } }',
        );
    });

    test('a band sits the distance from the edge the doc stores', async () => {
        const doc = bandedDoc(1, false);
        doc.getMap(PAGE_ROOT).set('headerDistance', 8);
        doc.getMap(PAGE_ROOT).set('footerDistance', 15);
        const css = await exportStyle('pdf-html', doc);
        expect(css).toMatch(/@top-center \{[^}]*padding-top: 8mm;/);
        expect(css).toMatch(/@bottom-center \{[^}]*padding-bottom: 15mm;/);
    });

    // A margin narrower than 1.27 cm holds the band at its edge.
    test('a band sits 1.27 cm from the edge, or at the margin when that is narrower', async () => {
        const doc = bandedDoc(1, false);
        doc.getMap(PAGE_ROOT).set('marginTop', 10);
        const css = await exportStyle('pdf-html', doc);
        expect(css).toMatch(/@top-center \{[^}]*padding-top: 10mm;/);
        expect(css).toMatch(/@bottom-center \{[^}]*padding-bottom: 12\.7mm;/);
    });

    // Browsers ignore running(), so the download places each band where the long page shows it.
    test('the HTML download shows the header first and the footer last, a page number as its #', async () => {
        const html = await exported('html', bandedDoc(2, false));
        const body = html.slice(html.indexOf('<body>'));
        expect(body.indexOf('Acme header')).toBeLessThan(body.indexOf('Body 1'));
        expect(body.indexOf('Page ')).toBeGreaterThan(body.indexOf('Body 2'));
        expect(body).toContain(`>${PAGE_NUMBER_TEXT}</span>`);
        const css = await exportStyle('html', bandedDoc(2, false));
        expect(css).not.toContain('running(');
        expect(css).not.toContain('@top-center');
        expect(css).not.toContain('counter(page');
    });

    // The counters number a field wherever it stands, so the PDF writes them with no band to hold one.
    test("the PDF counts a body's page number in a doc with no bands", async () => {
        const css = await exportStyle('pdf-html', seededDoc());
        expect(css).toContain('[data-type="page-number"][data-kind="page"]::after { content: counter(page); }');
        expect(css).toContain('[data-type="page-number"][data-kind="pages"]::after { content: counter(pages); }');
        expect(css).not.toContain('running(');
    });

    // WeasyPrint lays a running element out on every page, so an unbounded header ran the PDF into its timeout.
    test('the PDF prints a band past its caps up to them, with a warning that counts the band once', async () => {
        const doc = seededDoc();
        seedBand(doc, 'header', ...Array.from({ length: 4000 }, (_, index) => paragraph(`Head ${index}.`)));
        const { data, warnings } = await renderEigendocExport(
            doc,
            'pdf-html',
            'Report.eigendoc',
            async () => [],
            undefined,
        );
        const html = new TextDecoder().decode(data);
        expect(html).toContain(`Head ${MAX_BAND_BLOCKS - 1}.`);
        expect(html).not.toContain(`Head ${MAX_BAND_BLOCKS}.`);
        expect(warnings).toEqual([{ code: 'bands-cut', count: 1 }]);
    });

    // A table counts its rows, cells and paragraphs, so one block can pass the caps alone: it keeps what fits.
    test('the PDF cuts the block that passes the caps inside it, so a band keeps its first lines', async () => {
        const cell = (text: string) => ({ type: 'tableCell', content: [paragraph(text)] });
        const table = {
            type: 'table',
            content: Array.from({ length: 25 }, (_, row) => ({
                type: 'tableRow',
                content: Array.from({ length: 4 }, (_, column) => cell(`R${row}C${column}.`)),
            })),
        };
        const doc = seededDoc();
        seedBand(doc, 'header', table, paragraph('After the table'));
        seedBand(doc, 'footer', paragraph(`${'x'.repeat(MAX_BAND_TEXT)}Gone`));
        const { data, warnings } = await renderEigendocExport(
            doc,
            'pdf-html',
            'Report.eigendoc',
            async () => [],
            undefined,
        );
        const html = new TextDecoder().decode(data);
        expect(html).toContain('R0C0.');
        expect(html).toContain('R20C3.');
        expect(html).not.toContain('R24C3.');
        expect(html).not.toContain('After the table');
        expect(html).toContain('x'.repeat(MAX_BAND_TEXT));
        expect(html).not.toContain('Gone');
        // The header and the footer were cut, each once.
        expect(warnings).toEqual([{ code: 'bands-cut', count: 2 }]);
    });

    // Only the PDF lays a band out on every page; the docx and the download keep all of it.
    test.each(['html', 'docx'] as const)('the %s keeps a band past the caps whole', async (format) => {
        const doc = seededDoc();
        seedBand(doc, 'header', ...Array.from({ length: 300 }, (_, index) => paragraph(`Head ${index}.`)));
        const { data, warnings } = await renderEigendocExport(
            doc,
            format,
            'Report.eigendoc',
            async () => [],
            undefined,
        );
        const text =
            format === 'docx'
                ? new TextDecoder().decode(openZip(new Uint8Array(data)).read('word/header1.xml'))
                : new TextDecoder().decode(data);
        expect(text).toContain('Head 299.');
        expect(warnings).toEqual([]);
    });

    test("the HTML download's header is page 1's when page 1 differs", async () => {
        const html = await exported('html', bandedDoc(2, true));
        expect(html).toContain('Letterhead');
        expect(html).not.toContain('Acme header');
    });

    test("a header's equation draws as the body's: SVG in the PDF, MathML in the download", async () => {
        const doc = seededDoc();
        seedBand(doc, 'header', {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Header ' }, equation(writeMathml([{ kind: 'identifier', text: 'y' }]))],
        });
        const pdf = await exported('pdf-html', doc);
        expect(pdf.slice(pdf.indexOf('class="band-header"'), pdf.indexOf('Hello'))).toMatch(
            /Header <span class="math-svg"><svg /,
        );
        const html = await exported('html', doc);
        expect(html.slice(html.indexOf('class="band-header"'), html.indexOf('Hello'))).toContain(
            'Header <span class="equation"><math',
        );
    });

    // The bands come first, so the header's drawing is the first of MAX_SVG_EQUATIONS, and the body's last is text.
    test("the header's equations spend the body's budget", async () => {
        const numbers = Array.from({ length: mathSvg.MAX_SVG_EQUATIONS }, (_, i) =>
            equation(writeMathml([{ kind: 'number', text: String(i) }])),
        );
        const doc = seededDoc({ type: 'doc', content: [{ type: 'paragraph', content: numbers }] });
        seedBand(doc, 'header', {
            type: 'paragraph',
            content: [equation(writeMathml([{ kind: 'identifier', text: 'y' }]))],
        });
        const mathmlToSvg = spyOn(mathSvg, 'mathmlToSvg').mockImplementation(async () => '<svg></svg>');
        try {
            const html = await exported('pdf-html', doc);
            expect(mathmlToSvg).toHaveBeenCalledTimes(mathSvg.MAX_SVG_EQUATIONS);
            expect(html.match(/class="math-svg"/g)).toHaveLength(mathSvg.MAX_SVG_EQUATIONS);
            expect(html).toContain(`</svg></span>${mathSvg.MAX_SVG_EQUATIONS - 1}<br></p>`);
        } finally {
            mathmlToSvg.mockRestore();
        }
    });
});

// Each page's text from the boxes WeasyPrint lays out: the body's, then the margin boxes'.
const PAGE_TEXT_SCRIPT = `
import sys, weasyprint
def walk(box):
    yield box
    for child in getattr(box, 'children', None) or []:
        yield from walk(child)
for page in weasyprint.HTML(string=sys.stdin.read()).render().pages:
    print(''.join(box.text for box in walk(page._page_box) if hasattr(box, 'text')).strip())
`;

async function pageTexts(html: string): Promise<string[]> {
    return (await pythonOutput(['-c', PAGE_TEXT_SCRIPT], html)).trim().split('\n');
}

(weasyPrint && python !== null ? describe : describe.skip)('doc export — headers and footers (WeasyPrint)', () => {
    test('every page prints the header and the footer with its number and the count', async () => {
        expect(await pageTexts(await exported('pdf-html', bandedDoc(3, false)))).toEqual([
            'Body 1Acme headerPage 1 of 3',
            'Body 2Acme headerPage 2 of 3',
            'Body 3Acme headerPage 3 of 3',
        ]);
    }, 60_000);

    // No first-page footer: page 1 prints none.
    test('page 1 prints its own header and no footer when it differs', async () => {
        expect(await pageTexts(await exported('pdf-html', bandedDoc(2, true)))).toEqual([
            'Body 1Letterhead',
            'Body 2Acme headerPage 2 of 2',
        ]);
    }, 60_000);

    // A docx's NUMPAGES lands in the body of a doc with no bands, as Google's Page count goes anywhere text goes.
    test("a body's page number and page count print in a doc with no bands", async () => {
        const number = (kind: 'page' | 'pages') => ({ type: 'pageNumber', attrs: { kind } });
        const doc = seededDoc({
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Pages: ' }, number('pages')] },
                { type: 'pageBreak' },
                { type: 'paragraph', content: [{ type: 'text', text: 'Page ' }, number('page')] },
            ],
        });
        expect(await pageTexts(await exported('pdf-html', doc))).toEqual(['Pages: 2', 'Page 2']);
    }, 60_000);
});

// A doc of `pages` pages whose header and footer hold `lines` lines each, at the 2 cm margins, page 1's header one line
// when page 1 differs.
function tallBandsDoc(pages: number, lines: number, differentFirstPage = false): Y.Doc {
    const doc = seededDoc({
        type: 'doc',
        content: Array.from({ length: pages * 30 }, (_, index) => paragraph(`Body ${index + 1}`)),
    });
    const band = (name: string) => Array.from({ length: lines }, (_, index) => paragraph(`${name} ${index + 1}`));
    seedBand(doc, 'header', ...band('Header'));
    seedBand(doc, 'footer', ...band('Footer'));
    seedBand(doc, 'headerFirst', paragraph('Letterhead'));
    doc.getMap(PAGE_ROOT).set('differentFirstPage', differentFirstPage);
    return doc;
}

// weasyprint-render.py as the export runs it, counting its renders of the doc and of the band probe, whose body holds no
// text; then the first and last line of the header, the body and the footer on each page it printed, in px from the top
// of the paper. `broken` stands in for a WeasyPrint whose layout internals moved.
const RENDER_LINES_SCRIPT = `
import io, json, runpy, sys, weasyprint
from weasyprint.formatting_structure.boxes import LineBox, MarginBox, TextBox
broken = sys.argv[-1] == 'broken'
if broken:
    sys.argv.pop()
    sys.modules['weasyprint.formatting_structure.boxes'] = None
renders = []
render = weasyprint.HTML.render
def counted(self, *args, **kwargs):
    renders.append(render(self, *args, **kwargs))
    return renders[-1]
weasyprint.HTML.render = counted
out, sys.stdout = sys.stdout, io.TextIOWrapper(io.BytesIO())
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0])
def walk(box):
    for child in getattr(box, 'children', None) or []:
        yield child
        yield from walk(child)
def lines(box):
    for child in getattr(box, 'children', None) or []:
        yield from [child] if isinstance(child, LineBox) else lines(child)
def body_text(document):
    return ''.join(box.text for page in document.pages for margin in page._page_box.children
        if not isinstance(margin, MarginBox) for box in walk(margin) if isinstance(box, TextBox)).strip()
pages = []
for page in renders[-1].pages:
    row = {}
    for box in page._page_box.children:
        found = list(lines(box))
        name = 'body' if not isinstance(box, MarginBox) else 'header' if box.at_keyword.startswith('@top') else 'footer'
        if found:
            row[name] = [min(l.position_y for l in found), max(l.position_y + l.height for l in found)]
    pages.append(row)
full = sum(1 for document in renders if body_text(document))
out.write(json.dumps({'renders': full, 'probes': len(renders) - full, 'pages': pages}))
`;

type PrintedLines = { header?: number[]; body: number[]; footer?: number[] };

async function printedLines(
    doc: Y.Doc,
    options: { broken?: boolean } = {},
): Promise<{ renders: number; probes: number; pages: PrintedLines[] }> {
    const args = ['-c', RENDER_LINES_SCRIPT, renderScript, ...(options.broken ? ['broken'] : [])];
    return JSON.parse(await pythonOutput(args, await exported('pdf-html', doc)));
}

const px = (mm: number) => (mm / 25.4) * 96;
const MARGIN_PX = px(20);

(weasyPrint && python !== null ? describe : describe.skip)('doc export — a band taller than its margin', () => {
    // A margin box pushes nothing, so a probe of the bands alone measures what they need before the one render.
    test('pushes the body below the header and above the footer on every page, in one render', async () => {
        const { renders, probes, pages } = await printedLines(tallBandsDoc(3, 5));
        expect([renders, probes]).toEqual([1, 1]);
        expect(pages.length).toBeGreaterThanOrEqual(3);
        for (const { header, body, footer } of pages) {
            expect(header?.[1]).toBeGreaterThan(MARGIN_PX);
            expect(body[0]).toBeGreaterThanOrEqual(header?.[1] ?? Infinity);
            expect(body[1]).toBeLessThan(footer?.[0] ?? -Infinity);
        }
    }, 60_000);

    test('page 1 takes the margin its own header needs, the other pages the one theirs needs', async () => {
        const { renders, pages } = await printedLines(tallBandsDoc(3, 5, true));
        expect(renders).toBe(1);
        const [first, ...rest] = pages;
        expect(first.body[0]).toBeGreaterThanOrEqual(first.header?.[1] ?? Infinity);
        for (const { header, body } of rest) {
            expect(body[0]).toBeGreaterThanOrEqual(header?.[1] ?? Infinity);
            expect(body[0]).toBeGreaterThan(first.body[0] + 100);
        }
    }, 60_000);

    // The probe lays out a page 2 whatever the doc's length, so the page a grown page 1 pushes the body onto clears its
    // own header. 24 paragraphs are the most one page holds at the 2 cm margins.
    test("a one-page doc with page 1 different gives the page it spills onto the other pages' margin", async () => {
        const doc = seededDoc({
            type: 'doc',
            content: Array.from({ length: 24 }, (_, index) => paragraph(`Body ${index + 1}`)),
        });
        seedBand(doc, 'header', ...Array.from({ length: 6 }, (_, index) => paragraph(`Header ${index + 1}`)));
        seedBand(doc, 'headerFirst', ...Array.from({ length: 3 }, (_, index) => paragraph(`Letterhead ${index + 1}`)));
        doc.getMap(PAGE_ROOT).set('differentFirstPage', true);
        const { renders, pages } = await printedLines(doc);
        expect(renders).toBe(1);
        expect(pages.length).toBe(2);
        for (const { header, body } of pages) expect(body[0]).toBeGreaterThanOrEqual(header?.[1] ?? Infinity);
    }, 60_000);

    // A Header style's line has no space after, so it fits the 2 cm margin, and a footer ends on its 1.27 cm.
    test('a one-line header at the 2 cm margin keeps the margin, and the footer sits on its distance', async () => {
        const { renders, pages } = await printedLines(tallBandsDoc(2, 1));
        expect(renders).toBe(1);
        expect(pages[0].body[0]).toBeCloseTo(MARGIN_PX, 0);
        expect(pages[0].footer?.[1]).toBeCloseTo(px(297 - 12.7), 0);
    }, 60_000);

    // A 240 mm letterhead would leave each page a line of body.
    test('the grown margins leave the body half the page', async () => {
        const { renders, pages } = await printedLines(tallBandsDoc(2, 40));
        expect(renders).toBe(1);
        expect(pages.length).toBeLessThanOrEqual(6);
        for (const { body } of pages) expect(body[0]).toBeLessThan(px(297 / 2));
    }, 60_000);

    test('a doc without bands pays for no probe', async () => {
        const { renders, probes } = await printedLines(seededDoc());
        expect([renders, probes]).toEqual([1, 0]);
    }, 60_000);

    test('a WeasyPrint whose layout internals moved prints the doc once, its margins as set', async () => {
        const { renders, probes, pages } = await printedLines(tallBandsDoc(2, 5), { broken: true });
        expect([renders, probes]).toEqual([1, 0]);
        expect(pages[0].body[0]).toBeCloseTo(MARGIN_PX, 0);
    }, 60_000);
});

const note = (...paragraphs: JSONContent[]): JSONContent => ({ type: 'footnote', content: paragraphs });

// A claim with a two-paragraph note, its second paragraph holding a forged nested note, then a second claim's note.
const NOTED: JSONContent[] = [
    {
        type: 'paragraph',
        content: [
            { type: 'text', text: 'Claim' },
            note(
                { type: 'paragraph', content: [{ type: 'text', text: 'See', marks: [{ type: 'bold' }] }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Two' }, note(paragraph('nested'))] },
            ),
            { type: 'text', text: '.' },
        ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'Again' }, note(paragraph('Second'))] },
];

describe('doc export — footnotes', () => {
    // Through a spec HTML parser: a <p> in the body's <p> would close it.
    test('the PDF writes a note in its paragraph as spans, a note inside it as its text', async () => {
        const html = await pdfHtml(...NOTED);
        const { body } = new JSDOM(html).window.document;
        expect([...body.querySelectorAll('article > *')].map((element) => element.tagName)).toEqual(['P', 'P']);
        const paragraphs = [...body.querySelectorAll('p > span.footnote > span[data-type="footnote-paragraph"]')];
        expect(paragraphs.map((span) => span.innerHTML)).toEqual(['<strong>See</strong>', 'Two nested', 'Second']);
        expect(body.querySelector('.footnote .footnote')).toBeNull();
        expect(body.querySelector('.footnotes, sup')).toBeNull();
    });

    test('the PDF floats notes to the page foot only for a doc that has them', async () => {
        const css = await exportStyle('pdf-html', seededDoc({ type: 'doc', content: NOTED }));
        expect(css).toContain('float: footnote');
        expect(css).toContain('::footnote-call');
        expect(css).toContain('@footnote');
        expect(await exportStyle('pdf-html')).not.toContain('footnote');
    });

    // Google's HTML download: a superscript number linking to the note after the body, which links back.
    test('the HTML writes each reference as a linked number and the notes in a list after the body', async () => {
        const { body } = new JSDOM(await exported('html', seededDoc({ type: 'doc', content: NOTED }))).window.document;
        const references = [...body.querySelectorAll('p > sup > a')];
        expect(references.map((a) => [a.id, a.getAttribute('href'), a.textContent])).toEqual([
            ['fnref-1', '#fn-1', '1'],
            ['fnref-2', '#fn-2', '2'],
        ]);
        const items = [...body.querySelectorAll('section.footnotes > ol > li')];
        expect(items.map((li) => li.id)).toEqual(['fn-1', 'fn-2']);
        expect(items.map((li) => [...li.children].map((child) => child.innerHTML))).toEqual([
            ['<strong>See</strong>', 'Two nested <a href="#fnref-1">↩</a>'],
            ['Second <a href="#fnref-2">↩</a>'],
        ]);
        expect(body.querySelector('span.footnote')).toBeNull();
        // The list closes the body, before a footer.
        expect(body.querySelector('article')?.lastElementChild?.className).toBe('footnotes');
    });

    // A note floats whole to its page, so a taller one loses what doesn't fit, and WeasyPrint grows slow past about
    // 2,000 notes: past either, the PDF lists the notes after the body, as the download does.
    test.each<[string, JSONContent[]]>([
        [
            'a note longer than a page',
            [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Claim' },
                        note(...Array.from({ length: 300 }, (_, index) => paragraph(`Line ${index}`))),
                    ],
                },
            ],
        ],
        [
            `more than ${MAX_PAGE_NOTES} notes`,
            Array.from({ length: MAX_PAGE_NOTES + 1 }, (_, index) => ({
                type: 'paragraph',
                content: [{ type: 'text', text: `Body ${index}` }, note(paragraph(`Note ${index}`))],
            })),
        ],
    ])('the PDF of %s lists its notes after the body', async (_name, content) => {
        const doc = seededDoc({ type: 'doc', content });
        const html = await exported('pdf-html', doc);
        const { body } = new JSDOM(html).window.document;
        expect(body.querySelector('article')?.lastElementChild?.className).toBe('footnotes');
        expect(body.querySelector('span.footnote')).toBeNull();
        expect(await exportStyle('pdf-html', doc)).not.toContain('float: footnote');
    });

    // 52 lines fit Inter's line on A4 but not Source Serif 4's taller one, and a picture counts at its height.
    test.each<[string, JSONContent[]]>([
        ['52 lines under a serif Normal', Array.from({ length: 52 }, (_, index) => paragraph(`Line ${index}`))],
        [
            'two tall pictures',
            [
                paragraph('Pictured'),
                { type: 'paragraph', content: [{ type: 'figure', attrs: { mediaName: 'a.png', width: 600 } }] },
                { type: 'paragraph', content: [{ type: 'figure', attrs: { mediaName: 'b.png', width: 600 } }] },
            ],
        ],
    ])('the PDF of a note of %s lists its notes after the body', async (_name, paragraphs) => {
        const doc = styledDoc({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Claim' }, note(...paragraphs)] }],
        });
        const { body } = new JSDOM(await exported('pdf-html', doc)).window.document;
        expect(body.querySelector('span.footnote')).toBeNull();
        expect(body.querySelector('section.footnotes')).not.toBeNull();
    });

    test('a note just within a page stays at its foot', async () => {
        const html = await pdfHtml({
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Claim' },
                note(...Array.from({ length: 20 }, (_, index) => paragraph(`Line ${index}`))),
            ],
        });
        expect(html).toContain('<span class="footnote"');
    });

    // The notes listed after the body put a linked number in the heading, which the bookmark leaves out too.
    test("the PDF that lists its notes still labels a heading's bookmark without its note's number", async () => {
        const doc = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'heading',
                    attrs: { level: 1 },
                    content: [
                        { type: 'text', text: 'Intro' },
                        note(...Array.from({ length: 300 }, (_, index) => paragraph(`Line ${index}`))),
                    ],
                },
            ],
        });
        const { body } = new JSDOM(await exported('pdf-html', doc)).window.document;
        expect(body.querySelector('section.footnotes')).not.toBeNull();
        expect(body.querySelector('h1')?.getAttribute('data-bookmark')).toBe('Intro');
        expect(await exportStyle('pdf-html', doc)).toContain(
            '[data-bookmark] { bookmark-label: attr(data-bookmark); }',
        );
    });

    // A forged note may end in a block that is no paragraph; its link back follows it.
    test('a note whose last block is no paragraph still links back', async () => {
        const html = await exported(
            'html',
            seededDoc({
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: 'Claim' },
                            note(paragraph('First'), {
                                type: 'heading',
                                attrs: { level: 2 },
                                content: [{ type: 'text', text: 'Forged' }],
                            }),
                        ],
                    },
                ],
            }),
        );
        const item = new JSDOM(html).window.document.querySelector('#fn-1');
        expect(item?.querySelector('a[href="#fnref-1"]')?.textContent).toBe('↩');
    });

    // A heading's bookmark is its text: the call's number and the note it floats away are no part of it.
    test("the PDF labels a heading's bookmark with its text without its notes", async () => {
        const doc = seededDoc({
            type: 'doc',
            content: [
                {
                    type: 'heading',
                    attrs: { level: 1, textAlign: 'center' },
                    content: [
                        { type: 'text', text: 'Intro' },
                        note(paragraph('Aside')),
                        { type: 'text', text: ' & more' },
                    ],
                },
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plain' }] },
            ],
        });
        const { body } = new JSDOM(await exported('pdf-html', doc)).window.document;
        const [noted, plain] = [...body.querySelectorAll('h1, h2')];
        expect(noted?.getAttribute('data-bookmark')).toBe('Intro & more');
        expect(noted?.getAttribute('style')).toContain('text-align: center');
        expect(plain?.hasAttribute('data-bookmark')).toBe(false);
        expect(await exportStyle('pdf-html', doc)).toContain(
            '[data-bookmark] { bookmark-label: attr(data-bookmark); }',
        );
    });

    // readEigendocBands drops what a band's schema leaves out, so a peer's forged note never renders.
    test.each(['html', 'pdf-html'] as const)('%s drops a note a peer forged into a band', async (format) => {
        const doc = seededDoc();
        seedBand(doc, 'header', {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Head' }, note(paragraph('Forged'))],
        });
        const html = await exported(format, doc);
        expect(html).toContain('Head');
        expect(html).not.toContain('Forged');
        expect(html).not.toContain('footnote');
    });
});

(weasyPrint && python !== null ? describe : describe.skip)('doc export — footnotes (WeasyPrint)', () => {
    // Each page's text boxes, top down, as [text, y]: the body's and the footnote area's.
    const pagesOf = async (html: string): Promise<[string, number][][]> => {
        const lines = await laidOut(
            html,
            "if box is page._page_box: print('PAGE')\n        if type(box).__name__ == 'TextBox': print(box.position_y, box.text)",
        );
        const pages: [string, number][][] = [];
        for (const line of lines) {
            if (line === 'PAGE') pages.push([]);
            else {
                const [y, ...text] = line.split(' ');
                pages.at(-1)?.push([text.join(' '), Number(y)]);
            }
        }
        return pages;
    };

    test("a note prints at the foot of its reference's page, below the body, each paragraph a line", async () => {
        const body = Array.from({ length: 40 }, (_, index) => paragraph(`Body ${index + 1}`));
        const claim = {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Claim' }, note(paragraph('First line'), paragraph('Second line'))],
        };
        const pages = await pagesOf(await pdfHtml(...body, claim, paragraph('After')));
        const page = pages.findIndex((boxes) => boxes.some(([text]) => text === 'Claim'));
        expect(page).toBeGreaterThan(0);
        const boxes = pages[page];
        const y = (text: string) => boxes.find(([box]) => box === text)?.[1] ?? Number.NaN;
        const lowestBody = Math.max(
            ...boxes.filter(([text]) => /^(Body|Claim|After)/.test(text)).map(([, top]) => top),
        );
        expect(y('First line')).toBeGreaterThan(lowestBody);
        expect(y('Second line')).toBeGreaterThan(y('First line'));
        // The number in the text and at the note.
        expect(boxes.filter(([text]) => text.trim() === '1')).toHaveLength(2);
        for (const other of pages.filter((_, index) => index !== page))
            expect(other.some(([text]) => text.includes('line'))).toBe(false);
    }, 60_000);
});
