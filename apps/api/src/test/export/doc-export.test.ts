import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { openZip } from '../../lib/core/zip';
import { toTransferableText } from '../../lib/document/transform/protocol';
import { proseValue } from '../../lib/export/doc/prose-css';
import { renderEigendocExport, withSvgFallbacks } from '../../lib/export/doc/transform';
import { isWeasyPrintAvailable, shebangPython } from '../../lib/export/weasyprint';
import { docxToPmJson } from '../../lib/import/doc/from-docx';
import { seedEigendoc } from '../fixtures/golden-documents';

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

async function exportStyle(format: 'html' | 'pdf-html'): Promise<string> {
    const { data } = await renderEigendocExport(seededDoc(), format, 'Report.eigendoc', [], undefined);
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

    test('docx opens on the first paragraph, not an empty one', async () => {
        const xml = await docxDocumentXml(seededDoc());
        expect(xml.match(/<w:body>[\s\S]*?<\/w:p>/)?.[0]).toContain('Hello');
    });
});

describe('doc export — the stylesheet', () => {
    test('no CSS variable survives into the export', async () => {
        expect(await exportStyle('pdf-html')).not.toContain('var(');
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

// Worker.terminate() does not stop libvips, so only sharp's own timeout frees the one transform slot from a filter
// librsvg grinds through for minutes.
describe('doc export — docx SVG fallback timeout', () => {
    const slow = `<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="2560"><filter id="f" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.9" numOctaves="10"/></filter><rect width="2560" height="2560" filter="url(#f)"/></svg>`;
    const fast = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

    // Untimed, the slow one renders in seconds and gets a PNG, so its absence proves the timeout fired; a wall-clock
    // bound fails on a loaded CI runner, where the uninterruptible librsvg pass alone outlasts it.
    test('an SVG that outlasts the timeout gets no PNG fallback, and the next one still does', async () => {
        const media = await withSvgFallbacks(
            [
                { name: 'slow.svg', contentType: 'image/svg+xml', data: toTransferableText(slow) },
                { name: 'fast.svg', contentType: 'image/svg+xml', data: toTransferableText(fast) },
            ],
            1,
        );
        expect(media.map(({ name, png }) => [name, png !== undefined])).toEqual([['fast.svg', true]]);
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
    ])('an ol of type %s draws %s', (type, style) => {
        expect(proseValue(`.eigen-prose ol[type="${type}" s]`, 'list-style-type')).toBe(style);
    });
});

const weasyPrint = await isWeasyPrintAvailable();
const launcher = Bun.which('weasyprint');
const python = launcher ? shebangPython(await Bun.file(launcher).slice(0, 512).text()) : null;

// The text of every list marker WeasyPrint lays out for the page the PDF is written from.
const MARKER_SCRIPT = `
import sys, weasyprint
def walk(box):
    yield box
    for child in getattr(box, 'children', None) or []:
        yield from walk(child)
for page in weasyprint.HTML(string=sys.stdin.read()).render().pages:
    for box in walk(page._page_box):
        if 'marker' in str(getattr(box, 'element_tag', '')) and hasattr(box, 'text'):
            print(box.text.strip())
`;

async function markers(html: string): Promise<string[]> {
    if (python === null) throw new Error('no python behind the weasyprint launcher');
    const proc = Bun.spawn([python, '-I', '-c', MARKER_SCRIPT], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' });
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
        expect(await markers(html)).toEqual(['3.', 'v.', '4.', 'b.', 'c.', 'I.']);
    }, 60_000);
});
