import type { JSONContent } from '@tiptap/core';
import {
    BAND_DISTANCE_MM,
    BAND_ROOTS,
    type BandRoot,
    DOC_PROSE_CLASS,
    type NormalStyle,
    normalStyleProperties,
    PAGE_BAND_CLASS,
    PAGE_BREAK_CLASS,
    type PageSetup,
    pageStylesheet,
} from '@workspace/lib/docs/eigendoc';
import type * as Y from 'yjs';
import { readEigendocBands, readEigendocFromDoc, readEigendocPage, readEigendocStyle } from '../../document/doc';
import { readStoredEquation } from '../../document/equation';
import { FONT_STACK_MONO } from '../../document/font-stacks';
import { toDataUriMap } from '../../document/media';
import { PROSE_CSS } from '../../document/prose-css';
import {
    type EigendocExportFormat,
    type ExportMedia,
    htmlExportMode,
    type TransformWarning,
    toTransferableBuffer,
    toTransferableText,
} from '../../document/transform/protocol';
import { exportHtmlDocument } from '../html-document';
import { MAX_SVG_EQUATIONS, mathmlToSvg, SVG_LIMIT } from '../math-svg';
import { withSvgFallbacks } from '../office-image';
import {
    type EquationDrawing,
    equationBudget,
    equationDrawing,
    equationKey,
    equationMathml,
    renderDocHtml,
    renderEquations,
    withAbsoluteLinks,
} from './render';

// Materialized doc + prepared media → export bytes. Runs inside the transform process
// (child.ts owns execution; the main-thread orchestration lives in export-document.ts).
// This module must not reach the Mount or the preview cache — the child imports it.
//
// HTML and PDF render the same document by design: WeasyPrint consumes what the HTML download
// serves, but for the small caps the PDF fakes and the equations it draws as SVG (render.ts). The
// docx is written from the JSON by to-docx.ts, which loads lazily so an HTML export never evaluates
// it, its styles or its fonts.
export async function renderEigendocExport(
    doc: Y.Doc,
    format: EigendocExportFormat,
    title: string,
    media: ExportMedia[],
    publicOrigin: string | undefined,
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const json = readEigendocFromDoc(doc);
    const page = readEigendocPage(doc);
    const style = readEigendocStyle(doc);
    const bands = readEigendocBands(doc);
    if (format === 'docx') {
        const { eigendocToDocx, pastedFigureMedia } = await import('./to-docx');
        const pasted = await pastedFigureMedia([json, ...Object.values(bands)]);
        const docxMedia = await withSvgFallbacks([...media, ...pasted]);
        return {
            data: toTransferableBuffer(await eigendocToDocx(json, bands, page, style, docxMedia, title, publicOrigin)),
            warnings: [],
        };
    }
    const dataUriMap = toDataUriMap(media);
    const pdf = htmlExportMode(format) === 'pdf';
    // Browsers ignore running(), so the download shows each band where the long page does: page 1's header on top, the
    // other pages' footer at the end.
    const order: (BandRoot | 'body')[] = pdf
        ? [...BAND_ROOTS, 'body']
        : [page.differentFirstPage ? 'headerFirst' : 'header', 'body', 'footer'];
    const roots = order.flatMap((part) => {
        const content = part === 'body' ? json : bands[part];
        return content ? [{ part, content }] : [];
    });
    const equations = renderEquations(pdf ? await svgEquations(roots.map(({ content }) => content)) : undefined);
    const body = roots
        .map(({ part, content }) => {
            const html = renderDocHtml(
                withAbsoluteLinks(content, publicOrigin),
                (mediaName, src) => (mediaName ? (dataUriMap.get(mediaName) ?? null) : src),
                { ...(pdf && { smallCapsFont: style.font }), pageCounters: pdf, equations },
            );
            return part === 'body'
                ? `<article class="eigen-prose tiptap ${DOC_PROSE_CLASS}">${html}</article>`
                : `<div class="band-${part}"><article class="eigen-prose tiptap ${DOC_PROSE_CLASS} ${PAGE_BAND_CLASS}">${html}</article></div>`;
        })
        .join('');
    const html = exportHtmlDocument({
        title,
        css: `${PROSE_CSS}${printExtras(page, style)}${pdf && Object.keys(bands).length > 0 ? bandsCss(page) : ''}`,
        body: `<div class="page">${body}</div>`,
    });
    return { data: toTransferableText(html), warnings: [] };
}

// WeasyPrint draws no MathML, so the PDF draws its equations as the SVGs MathJax makes of the MathML the screen draws,
// keyed by stored string, each drawn once, in the order the render meets them, the bands' first. Every copy spends
// SVG_LIMIT; MathJax stops at the first equation that does not fit, or past MAX_SVG_EQUATIONS drawings, and the render
// prints the rest as text.
async function svgEquations(roots: JSONContent[]): Promise<Map<string, EquationDrawing>> {
    const drawings = new Map<string, EquationDrawing>();
    const fits = equationBudget(SVG_LIMIT);
    for (const attrs of equationAttrs(roots)) {
        const key = equationKey(attrs);
        let drawing = drawings.get(key);
        if (drawing === undefined && drawings.size < MAX_SVG_EQUATIONS) {
            const { row, display } = readStoredEquation(attrs);
            const svg = await mathmlToSvg(equationMathml(row, display));
            drawing = equationDrawing(`<span class="math-svg"${display ? ' data-display="block"' : ''}>${svg}</span>`);
        }
        if (drawing === undefined || !fits(drawing)) break;
        drawings.set(key, drawing);
    }
    return drawings;
}

function* equationAttrs(nodes: JSONContent[]): Generator<Record<string, unknown>> {
    for (const node of nodes) {
        if (node.type === 'equation') yield node.attrs ?? {};
        yield* equationAttrs(node.content ?? []);
    }
}

// The bands are running elements placed before the body, as element() takes the one placed on the page or the last one
// before it, and print in the margin boxes over the text column, 1.27 cm from the edge or at a narrower margin's. A band
// taller than its margin gets the margin it needs from weasyprint-render.py, as a margin box pushes nothing. In the head,
// which the sanitizer never sees: it strips element( from a body's CSS.
function bandsCss(page: PageSetup): string {
    const top = Math.min(BAND_DISTANCE_MM, page.margin.top);
    const bottom = Math.min(BAND_DISTANCE_MM, page.margin.bottom);
    return `
${BAND_ROOTS.map((root) => `.band-${root} { position: running(${root}); }`).join('\n')}
@page {
    @top-center { content: element(header); vertical-align: top; padding-top: ${top}mm; width: 100%; }
    @bottom-center { content: element(footer); vertical-align: bottom; padding-bottom: ${bottom}mm; width: 100%; }
}
${page.differentFirstPage ? '@page :first { @top-center { content: element(headerFirst); } @bottom-center { content: element(footerFirst); } }' : ''}
[data-type="page-number"][data-kind="page"]::after { content: counter(page); }
[data-type="page-number"][data-kind="pages"]::after { content: counter(pages); }
`;
}

function printExtras(page: PageSetup, style: NormalStyle): string {
    const normal = Object.entries(normalStyleProperties(style)).map(([name, value]) => `${name}: ${value};`);
    return `
/* The docs page as the editor draws it; on paper @page draws the margins */
${pageStylesheet(page, '.page')}${normal.length > 0 ? `\n.page { ${normal.join(' ')} }` : ''}

/* Minimal Tailwind preflight — reset browser defaults that conflict with eigen-prose */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
ul, ol { list-style: none; }
img, svg { display: block; max-width: 100%; }
input, button, textarea, select { font: inherit; color: inherit; background-color: transparent; border-radius: 0; }
a { color: inherit; text-decoration: inherit; }
table { border-collapse: collapse; border-spacing: 0; }
h1, h2, h3, h4, h5, h6 { font-size: inherit; }

.page {
    max-width: 100%;
    margin: 0 auto;
    overflow-wrap: anywhere;
}

/* A block holding a page break must split: avoid pushes it whole to a new page and breaks inside it anyway */
.figure, table, pre, blockquote { page-break-inside: avoid; }
table:has(.${PAGE_BREAK_CLASS}), blockquote:has(.${PAGE_BREAK_CLASS}) { page-break-inside: auto; }

pre code { white-space: pre-wrap; font-family: ${FONT_STACK_MONO}; }

/* The PDF's equations: MathJax's vertical-align sets an inline one on the baseline, and breaks no line, so one wider
   than the column scales down to it; a displayed one takes its line as in the editor, a full-width box on the bottom
   of the line that keeps the trailing <br> */
.math-svg > svg { display: inline; max-width: 100%; }
.math-svg[data-display] { display: inline-block; width: 100%; text-align: center; vertical-align: bottom; }

/* Task list checkboxes — explicit sizing to match editor (16px) */
ul[data-type="taskList"] li > label input[type="checkbox"] {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: #2563eb;
}
`;
}
