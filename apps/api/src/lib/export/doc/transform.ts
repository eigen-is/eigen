import type { JSONContent } from '@tiptap/core';
import { EIGEN_FONT_NAMES, EIGEN_FONTS, getFontName } from '@workspace/lib/constants/fonts';
import {
    BAND_DISTANCE_MM,
    BAND_ROOTS,
    type BandRoot,
    DOC_PROSE_CLASS,
    FOOTNOTE_PARAGRAPH,
    footnotesInOrder,
    mmToPt,
    type NormalStyle,
    normalStyleProperties,
    PAGE_BAND_CLASS,
    PAGE_BREAK_CLASS,
    type PageSetup,
    pageStylesheet,
    pxToPt,
} from '@workspace/lib/docs/eigendoc';
import type * as Y from 'yjs';
import {
    type EigendocBands,
    readEigendocBands,
    readEigendocFromDoc,
    readEigendocPage,
    readEigendocStyle,
} from '../../document/doc';
import { docSchema } from '../../document/doc-schema';
import { readStoredEquation } from '../../document/equation';
import { FONT_STACK_MONO } from '../../document/font-stacks';
import { BODY, FOOTNOTE_LOOK } from '../../document/looks';
import { mediaNamesIn, toDataUriMap } from '../../document/media';
import { PROSE_CSS } from '../../document/prose-css';
import {
    type EigendocExportFormat,
    type ExportMediaLoader,
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
    loadMedia: ExportMediaLoader,
    publicOrigin: string | undefined,
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const json = readEigendocFromDoc(doc);
    const page = readEigendocPage(doc);
    const style = readEigendocStyle(doc);
    const bands = readEigendocBands(doc);
    const media = await loadMedia(mediaNamesIn([json, bands]));
    if (format === 'docx') {
        const { chartFigureMedia, eigendocToDocx, pastedFigureMedia } = await import('./to-docx');
        const roots = [json, ...Object.values(bands)];
        const drawn = [...(await pastedFigureMedia(roots)), ...(await chartFigureMedia(roots))];
        const docxMedia = await withSvgFallbacks([...media, ...drawn]);
        return {
            data: toTransferableBuffer(await eigendocToDocx(json, bands, page, style, docxMedia, title, publicOrigin)),
            warnings: [],
        };
    }
    const dataUriMap = toDataUriMap(media);
    const pdf = htmlExportMode(format) === 'pdf';
    const { printed, cut } = pdf ? printedBands(bands) : { printed: bands, cut: 0 };
    const warnings: TransformWarning[] = cut > 0 ? [{ code: 'band-blocks-cut', count: cut }] : [];
    // Browsers ignore running(), so the download shows each band where the long page does: page 1's header on top, the
    // other pages' footer at the end.
    const order: (BandRoot | 'body')[] = pdf
        ? [...BAND_ROOTS, 'body']
        : [page.differentFirstPage ? 'headerFirst' : 'header', 'body', 'footer'];
    const roots = order.flatMap((part) => {
        const content = part === 'body' ? json : printed[part];
        return content ? [{ part, content }] : [];
    });
    const notes = footnotesInOrder(json);
    const pageNotes = pdf && notesFitPages(notes, page);
    const equations = renderEquations(pdf ? await svgEquations(roots.map(({ content }) => content)) : undefined);
    const body = roots
        .map(({ part, content }) => {
            const html = renderDocHtml(
                withAbsoluteLinks(content, publicOrigin),
                (mediaName, src) => (mediaName ? (dataUriMap.get(mediaName) ?? null) : src),
                { ...(pdf && { smallCapsFont: style.font }), pageCounters: pdf, pageFootnotes: pageNotes, equations },
            );
            return part === 'body'
                ? `<article class="eigen-prose tiptap ${DOC_PROSE_CLASS}">${html}</article>`
                : `<div class="band-${part}"><article class="eigen-prose tiptap ${DOC_PROSE_CLASS} ${PAGE_BAND_CLASS}">${html}</article></div>`;
        })
        .join('');
    const notesCss = notes.length > 0 ? (pageNotes ? PAGE_FOOTNOTES_CSS : FOOTNOTE_LIST_CSS) : '';
    const html = exportHtmlDocument({
        title,
        fonts: usedFamilies(body, style),
        css: `${PROSE_CSS}${printExtras(page, style)}${notesCss}${pdf && Object.keys(printed).length > 0 ? bandsCss(page) : ''}`,
        body: `<div class="page">${body}</div>`,
    });
    return { data: toTransferableText(html), warnings };
}

// WeasyPrint lays a running element out again on every page, so a 4,000-paragraph header ran a PDF past its 60 s. Half
// an A4 page, 421 pt, holds about 60 lines of 6 pt text, 200 characters a line, and a band taller than half the page
// prints over the body anyway (weasyprint-render.py), so a band within these caps keeps all it shows clear of the body.
export const MAX_BAND_BLOCKS = 200;
export const MAX_BAND_TEXT = 20_000;

// The bands as the PDF prints them: each one's blocks in document order, counted inside tables and lists, while they
// fit, and the one that passes the caps cut inside to what fits, so a band keeps its first lines whatever their size.
// cut counts the top-level blocks shortened or dropped.
function printedBands(bands: EigendocBands): { printed: EigendocBands; cut: number } {
    const { nodes } = docSchema();
    const printed: EigendocBands = {};
    let cut = 0;
    for (const root of BAND_ROOTS) {
        const band = bands[root];
        if (!band) continue;
        let blocks = MAX_BAND_BLOCKS;
        let text = MAX_BAND_TEXT;
        let short = false;
        const fit = (node: JSONContent): JSONContent | undefined => {
            if (node.text !== undefined) {
                const kept = node.text.slice(0, Math.max(0, text));
                text -= kept.length;
                short ||= kept.length < node.text.length;
                return kept ? { ...node, text: kept } : undefined;
            }
            if (nodes[node.type ?? '']?.isBlock && --blocks < 0) {
                short = true;
                return undefined;
            }
            if (!node.content) return node;
            const content: JSONContent[] = [];
            for (const child of node.content) {
                const kept = fit(child);
                if (!kept) break;
                content.push(kept);
            }
            short ||= content.length < node.content.length;
            return { ...node, content };
        };
        const content: JSONContent[] = [];
        for (const block of band.content ?? []) {
            short = false;
            const kept = fit(block);
            if (kept) content.push(kept);
            if (short) cut++;
        }
        printed[root] = { ...band, content };
    }
    return { printed, cut };
}

// The bundled families a doc's export can draw in, as a face is up to 0.6 MB of base64 WeasyPrint reads per PDF: the
// Normal's, in which eigen-prose.css draws the body and which names no other as its fallback, the monospace of code,
// and each family a font mark's style or a chart's SVG names in the body. A body's text that names a family embeds it
// for nothing, and misses none.
function usedFamilies(body: string, style: NormalStyle): Set<string> {
    const families = new Set([style.font]);
    if (body.includes('<code')) families.add(getFontName(FONT_STACK_MONO));
    for (const name of EIGEN_FONT_NAMES) if (body.includes(name)) families.add(name);
    return families;
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

// A note floats whole to its reference's page, so one taller than the page's text loses what doesn't fit, and
// WeasyPrint lays the notes out again for every page they fill: 4,000 one-line notes took 35 s and 10,000 ran past the
// 60 s timeout. Past either, the PDF lists the notes after the body, as the download does.
export const MAX_PAGE_NOTES = 1500;

// A note's lines at 10 pt in the tallest bundled face, as its runs may draw in any, a character at most 0.6 em wide on
// average, and a picture as tall as it is wide, or as the column where it stores no width, a chart at its height:
// against the page's text less the reference's line and the rule above the notes.
function notesFitPages(notes: JSONContent[], page: PageSetup): boolean {
    if (notes.length > MAX_PAGE_NOTES) return false;
    const { sizePt } = FOOTNOTE_LOOK;
    const columnPt = mmToPt(page.width - page.margin.left - page.margin.right);
    const linePt = sizePt * Math.max(...EIGEN_FONTS.map((font) => font.lineHeight));
    const lineChars = columnPt / (0.6 * sizePt);
    const pageLines = mmToPt(page.height - page.margin.top - page.margin.bottom) / linePt - 3;
    const pictureLines = (node: JSONContent): number => {
        const { width, height } = node.attrs ?? {};
        const tall = node.type === 'chart' ? height : node.type === 'figure' ? width : undefined;
        const own = typeof tall === 'number' && tall > 0 ? Math.min(pxToPt(tall), columnPt) : columnPt;
        const lines = node.type === 'chart' || node.type === 'figure' ? Math.ceil(own / linePt) : 0;
        return lines + (node.content ?? []).reduce((sum, child) => sum + pictureLines(child), 0);
    };
    const textOf = (node: JSONContent): number =>
        (node.text?.length ?? 0) + (node.content ?? []).reduce((sum, child) => sum + textOf(child), 0);
    return notes.every(
        (note) =>
            (note.content ?? []).reduce(
                (lines, block) => lines + Math.max(1, Math.ceil(textOf(block) / lineChars)) + pictureLines(block),
                0,
            ) <= pageLines,
    );
}

// A note floats to the foot of its reference's page, numbered in the text and at the note, under a short rule, as Google
// prints it. The note inherits from its reference's paragraph, a heading's, a title's, a quote's or a list item's, and
// its call too, which takes that text's size: so the note's own font has no line of its own (line-height 0), and its
// paragraphs and marker set the note's look. The first paragraph is inline, so the marker stays on its line. A page's
// footnote area draws its background at the image's own size, and reads no background-size, so the rule is an SVG
// 2 inches long, Word's separator.
const PAGE_FOOTNOTES_CSS = `
.footnote { float: footnote; line-height: 0; text-align: start; text-indent: 0; }
.footnote::footnote-call { content: counter(footnote); vertical-align: super; font-size: 0.75em; line-height: 0; }
.footnote::footnote-marker, .footnote > [data-type="${FOOTNOTE_PARAGRAPH}"] {
    font-size: ${FOOTNOTE_LOOK.sizePt}pt;
    font-weight: 400;
    font-style: normal;
    font-variant: normal;
    line-height: normal;
    letter-spacing: normal;
    text-transform: none;
    color: var(--doc-color, #${BODY.color});
}
.footnote::footnote-marker { content: counter(footnote) ' '; vertical-align: super; font-size: ${FOOTNOTE_LOOK.sizePt * 0.75}pt; }
.footnote > [data-type="${FOOTNOTE_PARAGRAPH}"] { display: block; }
.footnote > [data-type="${FOOTNOTE_PARAGRAPH}"]:first-child { display: inline; }
@page {
    @footnote {
        margin-top: 1em;
        padding-top: 4pt;
        background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='144pt' height='0.5pt'%3E%3Crect width='100%25' height='100%25' fill='%23${BODY.color}'/%3E%3C/svg%3E") no-repeat top left;
    }
}
`;

// The HTML download's notes after the body, in the note size under a short rule.
const FOOTNOTE_LIST_CSS = `
.footnotes { font-size: ${FOOTNOTE_LOOK.sizePt}pt; }
.footnotes hr { width: 144pt; margin: 2em 0 1em; }
`;

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
   than the column scales down to it, its height with it, as WeasyPrint 70 reads a root svg element's ex width and height as
   CSS; a displayed one takes its line as in the editor, a full-width box on the bottom of the line that keeps the
   trailing <br> */
.math-svg > svg { display: inline; max-width: 100%; height: auto; }
.math-svg[data-display] { display: inline-block; width: 100%; text-align: center; vertical-align: bottom; }

/* The PDF's bookmark of a heading that holds a note: its own text, without the note's number */
[data-bookmark] { bookmark-label: attr(data-bookmark); }

/* Task list checkboxes — explicit sizing to match editor (16px) */
ul[data-type="taskList"] li > label input[type="checkbox"] {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: #2563eb;
}
`;
}
