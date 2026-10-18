import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { sampleChartSpec } from '@workspace/lib/charts';
import { getFontFamily } from '@workspace/lib/constants/fonts';
import { PAGE_ROOT, pageRecord } from '@workspace/lib/docs/eigendoc';
import { escapeXml } from '@workspace/lib/xml';
import { MATHML_NAMESPACE, type MathNode, type MathRow, writeMathml, writeText } from '@workspace/math';
import { JSDOM } from 'jsdom';
import sharp from 'sharp';
import * as Y from 'yjs';
import { openZip } from '../../lib/core/zip';
import * as storedEquation from '../../lib/document/equation';
import { proseValue } from '../../lib/document/prose-css';
import { toTransferableText } from '../../lib/document/transform/protocol';
import { MATHML_LIMIT, renderDocHtml } from '../../lib/export/doc/render';
import { renderEigendocExport } from '../../lib/export/doc/transform';
import * as mathSvg from '../../lib/export/math-svg';
import { sanitizeExportHtml } from '../../lib/export/sanitize';
import { isWeasyPrintAvailable, shebangPython } from '../../lib/export/weasyprint';
import { docxToPmJson } from '../../lib/import/doc/from-docx';
import * as thumbnailTimeout from '../../lib/shared/thumbnail-timeout';
import { corpusEquations, equation, seedEigendoc } from '../fixtures/golden-documents';

function seededDoc(json: JSONContent = { type: 'doc', content: [paragraph('Hello')] }): Y.Doc {
    const doc = new Y.Doc();
    seedEigendoc(doc, json);
    return doc;
}

function paragraph(text: string): JSONContent {
    return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function brokenDoc(): Y.Doc {
    return seededDoc({ type: 'doc', content: [paragraph('Before'), { type: 'pageBreak' }, paragraph('After')] });
}

async function docxDocumentXml(doc: Y.Doc): Promise<string> {
    const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', [], undefined);
    return new TextDecoder().decode(openZip(new Uint8Array(data)).read('word/document.xml'));
}

async function exportStyle(format: 'html' | 'pdf-html', doc = seededDoc()): Promise<string> {
    const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', [], undefined);
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
        for (const [key, value] of Object.entries(pageRecord({ ...page, differentFirstPage: false })))
            map.set(key, value);
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

    test('docx opens on the first paragraph, not an empty one', async () => {
        const xml = await docxDocumentXml(seededDoc());
        expect(xml.match(/<w:body>[\s\S]*?<\/w:p>/)?.[0]).toContain('Hello');
    });
});

describe('doc export — the stylesheet', () => {
    // The app's tokens (--font-sans and the like) are not in the export; a property the stylesheet declares itself is.
    test.each(['html', 'pdf-html'] as const)('%s declares every CSS variable it reads', async (format) => {
        const css = await exportStyle(format);
        for (const [, name] of css.matchAll(/var\((--[\w-]+)/g)) expect(css).toContain(`${name}:`);
    });

    test('headings print at medium and bold at 600', async () => {
        const css = await exportStyle('pdf-html');
        expect(css).toMatch(/h6 \{[^}]*font-weight: 500;/);
        expect(css).toMatch(/\.eigen-prose th \{[^}]*font-weight: 500;/);
        expect(css).toMatch(/strong \{ font-weight: 600; \}/);
    });

    test('h5 and h6 print at the body size, which only eigen-prose sets', async () => {
        const css = await exportStyle('pdf-html');
        expect(css).toContain('h1, h2, h3, h4, h5, h6 { font-size: inherit; }');
        expect(css.match(/font-size: 11pt/g)).toHaveLength(1);
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
        expect(css.match(/color: #1a1a2e/g)).toHaveLength(1);
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

    test('a table or quote holding a page break may split, and the figure box stays whole', async () => {
        const css = await exportStyle('pdf-html');

        expect(css).toContain('.figure, table, pre, blockquote { page-break-inside: avoid; }');
        expect(css).toContain('table:has(.page-break), blockquote:has(.page-break) { page-break-inside: auto; }');
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
            const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', [], undefined);
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
        const { data } = await renderEigendocExport(seededDoc(json), 'html', 'Report.eigendoc', media, undefined);
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

describe('doc export — charts', () => {
    const chartDoc = (attrs: Record<string, unknown>, spec = sampleChartSpec('column')): JSONContent => ({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'chart', attrs: { spec: JSON.stringify(spec), ...attrs } }] }],
    });

    // Inline, so WeasyPrint draws the labels in the page's own fonts; an <img> of an SVG can't reach @font-face.
    test.each(['html', 'pdf-html'] as const)(
        '%s draws a chart as inline SVG at its size in the figure box, its labels as text',
        async (format) => {
            const doc = seededDoc(chartDoc({ width: 480, height: 300, alignment: 'right', caption: 'Points' }));
            const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', [], undefined);
            const html = new TextDecoder().decode(data);
            expect(html).toContain(
                '<span class="figure" data-layout="block" data-alignment="right"><svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">',
            );
            // Never wider than the column, its height following, by the prose rule the editor's node view draws with.
            expect(html).toMatch(/\.figure svg\s*\{[^}]*max-width: 100%;[^}]*height: auto;/);
            expect(html).toMatch(/<text[^>]*>Team 1<\/text>/);
            expect(html).toContain('</svg><span class="figcaption">Points</span></span>');
            expect(html).not.toContain('<img');
        },
    );

    test("every label draws in the spec's font", () => {
        const fontsOf = (html: string) =>
            new Set(Array.from(html.matchAll(/<text[^>]*font-family="([^"]*)"/g), (m) => m[1]));
        const face = (font: string) => new Set([escapeXml(getFontFamily(font))]);
        expect(fontsOf(renderDocHtml(chartDoc({}), () => null))).toEqual(face('Inter'));
        const serif = { ...sampleChartSpec('column'), fontFamily: 'Source Serif 4' };
        expect(fontsOf(renderDocHtml(chartDoc({}, serif), () => null))).toEqual(face('Source Serif 4'));
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
            [],
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
        const { data } = await renderEigendocExport(brokenDoc(), format, 'Report.eigendoc', [], undefined);
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
        const { data } = await renderEigendocExport(brokenDoc(), 'docx', 'Report.eigendoc', [], undefined);
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
        const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', [], undefined);
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
        const { data } = await renderEigendocExport(doc, 'pdf-html', 'Report.eigendoc', [], undefined);
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
            const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', [], undefined);
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
        const { data } = await renderEigendocExport(resized(), format, 'Report.eigendoc', [], undefined);
        const { document } = new JSDOM(new TextDecoder().decode(data)).window;
        const cols = [...document.querySelectorAll<HTMLTableColElement>('table col')];
        expect(cols.map((col) => col.style.width)).toEqual(['300px', '150px', '120px']);
        expect(document.querySelector('table')?.style.width).toBe('570px');
    });

    test('a docx export imports back with the same widths', async () => {
        const { data } = await renderEigendocExport(resized(), 'docx', 'Report.eigendoc', [], undefined);
        const { json } = docxToPmJson(Buffer.from(data));
        const widths = json.content?.[0]?.content?.flatMap((tableRow) =>
            (tableRow.content ?? []).map((node) => node.attrs?.['colwidth']),
        );
        expect(widths).toEqual([[300], [150], [120], [300], [150], [120]]);
    });
});

describe('doc export — whitespace', () => {
    test.each(['html', 'pdf-html'] as const)(
        '%s keeps repeated spaces and prints no whitespace around the body',
        async (format) => {
            const doc = seededDoc({ type: 'doc', content: [paragraph('a  b')] });
            const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', [], undefined);
            const html = new TextDecoder().decode(data);
            expect(html).toContain('<p>a  b</p>');
            expect(html).toMatch(/<article class="eigen-prose tiptap"><p>/);
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
            [],
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

// The docx writer's rule (doc-docx.test.ts), so a link to another Eigen file works in every format.
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
        const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', [], publicOrigin);
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
        const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', [], undefined);
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
        const { data } = await renderEigendocExport(doc, 'html', 'Report.eigendoc', [], undefined);
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
        const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', media, undefined);
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
        const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', [], undefined);
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
            const { data } = await renderEigendocExport(doc, 'docx', 'Report.eigendoc', media, undefined);
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
    const { data } = await renderEigendocExport(doc, 'pdf-html', 'Report.eigendoc', [], undefined);
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
            const { data } = await renderEigendocExport(doc, format, 'Report.eigendoc', [], undefined);
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

    test('a decimal ol draws no marker style of its own', async () => {
        const html = await pdfHtml(
            orderedList({ type: '1' }, listItem('a')),
            orderedList({ type: 'x' }, listItem('b')),
        );
        expect(html).toContain('<ol type="x">');
        expect(html).not.toMatch(/<ol [^>]*style=/);
    });
});

const weasyPrint = await isWeasyPrintAvailable();
const launcher = Bun.which('weasyprint');
const python = launcher ? shebangPython(await Bun.file(launcher).slice(0, 512).text()) : null;

// What `line` prints of each box WeasyPrint lays out for the pages the PDF is written from, `tag` its element's name.
async function laidOut(html: string, line: string): Promise<string[]> {
    if (python === null) throw new Error('no python behind the weasyprint launcher');
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
    const proc = Bun.spawn([python, '-I', '-c', script], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
    proc.stdin.write(html);
    await proc.stdin.end();
    return (await new Response(proc.stdout).text()).trim().split('\n');
}

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
