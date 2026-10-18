import type { JSONContent } from '@tiptap/core';
import {
    type NormalStyle,
    normalStyleProperties,
    PAGE_BREAK_CLASS,
    type PageSetup,
    pageStylesheet,
    readFigureAttrs,
} from '@workspace/lib/docs/eigendoc';
import type * as Y from 'yjs';
import { readEigendocFromDoc, readEigendocPage, readEigendocStyle } from '../../document/doc';
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
import { splitDataUri } from '../../shared/data-uri';
import { THUMBNAIL_TIMEOUT_SECONDS } from '../../shared/thumbnail-timeout';
import { exportHtmlDocument } from '../html-document';
import { MAX_SVG_EQUATIONS, mathmlToSvg, SVG_LIMIT } from '../math-svg';
import { DOCX_IMAGE_MAX_SIZE, encodeDocxImage, figureMediaKey } from './docx-image';
import {
    type EquationDrawing,
    equationBudget,
    equationDrawing,
    equationKey,
    equationMathml,
    renderDocHtml,
    withAbsoluteLinks,
} from './render';
import type { DocxMedia } from './to-docx';

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
    if (format === 'docx') {
        const { eigendocToDocx } = await import('./to-docx');
        const docxMedia = await withSvgFallbacks([...media, ...(await pastedFigureMedia(json))]);
        return {
            data: toTransferableBuffer(await eigendocToDocx(json, page, style, docxMedia, title, publicOrigin)),
            warnings: [],
        };
    }
    const dataUriMap = toDataUriMap(media);
    const pdf = htmlExportMode(format) === 'pdf';
    const body = renderDocHtml(
        withAbsoluteLinks(json, publicOrigin),
        (mediaName, src) => (mediaName ? (dataUriMap.get(mediaName) ?? null) : src),
        pdf ? { smallCapsFont: style.font, svgEquations: await svgEquations(json) } : {},
    );
    const html = exportHtmlDocument({
        title,
        css: `${PROSE_CSS}${printExtras(page, style)}`,
        body: `<div class="page"><article class="eigen-prose tiptap">${body}</article></div>`,
    });
    return { data: toTransferableText(html), warnings: [] };
}

// WeasyPrint draws no MathML, so the PDF draws its equations as the SVGs MathJax makes of the MathML the screen draws,
// keyed by stored string, each drawn once, in document order. Every copy spends SVG_LIMIT; MathJax stops at the first
// equation that does not fit, or past MAX_SVG_EQUATIONS drawings, and the render prints the rest as text.
async function svgEquations(json: JSONContent): Promise<Map<string, EquationDrawing>> {
    const drawings = new Map<string, EquationDrawing>();
    const fits = equationBudget(SVG_LIMIT);
    for (const attrs of equationAttrs(json)) {
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

function* equationAttrs(node: JSONContent): Generator<Record<string, unknown>> {
    if (node.type === 'equation') yield node.attrs ?? {};
    for (const child of node.content ?? []) yield* equationAttrs(child);
}

// A figure pasted with a data: src has no media file, and the main thread never reads the doc, so each src is decoded
// here, once, through the encode a media file takes; an SVG through the sanitizer the main thread's media took.
async function pastedFigureMedia(json: JSONContent): Promise<ExportMedia[]> {
    const pasted = new Map<string, { mediaType: string | null; base64: string }>();
    const visit = (node: JSONContent) => {
        if (node.type === 'figure') {
            const attrs = readFigureAttrs(node.attrs ?? {});
            const key = figureMediaKey(attrs);
            if (key && key === attrs.src) {
                const split = splitDataUri(key);
                if (split) pasted.set(key, split);
            }
        }
        for (const child of node.content ?? []) visit(child);
    };
    visit(json);
    if (pasted.size === 0) return [];
    const { sharpResize } = await import('../../shared/sharp-resize');
    const media: ExportMedia[] = [];
    for (const [src, { mediaType, base64 }] of pasted) {
        const data = Buffer.from(base64, 'base64');
        if (mediaType === 'image/svg+xml') {
            media.push({ name: src, contentType: mediaType, data: toTransferableBuffer(data) });
            continue;
        }
        const item = await encodeDocxImage(src, mediaType ?? '', data, (options) => sharpResize(data, options));
        if (item) media.push(item);
    }
    if (!media.some((item) => item.contentType === 'image/svg+xml')) return media;
    const { sanitizeExportMedia } = await import('../sanitize');
    return sanitizeExportMedia(media);
}

// The PNG a reader without SVG draws, from the sanitized XML the svgBlip carries, so both draw one picture. One at a
// time, for one decode's memory; sharp loads only for an SVG.
async function withSvgFallbacks(media: ExportMedia[]): Promise<DocxMedia[]> {
    if (!media.some((item) => item.contentType === 'image/svg+xml')) return media;
    const { default: sharp } = await import('sharp');
    const prepared: DocxMedia[] = [];
    for (const item of media) {
        if (item.contentType !== 'image/svg+xml') {
            prepared.push(item);
            continue;
        }
        try {
            const svg = Buffer.from(item.data);
            const image = sharp(svg);
            const { width = 0, height = 0 } = await image.metadata();
            const png = await image
                .resize(DOCX_IMAGE_MAX_SIZE, DOCX_IMAGE_MAX_SIZE, { fit: 'inside', withoutEnlargement: true })
                .png()
                .timeout({ seconds: THUMBNAIL_TIMEOUT_SECONDS })
                .toBuffer();
            prepared.push({ ...item, png: toTransferableBuffer(png), ...cssSize(svg, width, height) });
        } catch {
            // One librsvg can't read, or not in time, leaves the docx; its caption stays.
        }
    }
    return prepared;
}

const PHYSICAL_LENGTH = /^\s*[\d.e+-]+\s*(in|cm|mm|pt|pc)\s*$/i;

// sharp reads an SVG's physical units at 72 dpi and CSS at 96, so a 4in drawing is 288 px to it and 384 in the HTML
// export. Scaled per side, read off the root's start tag; a side the root leaves out follows the other, as sharp
// derives it from the viewBox.
function cssSize(svg: Buffer, width: number, height: number): { width: number; height: number } {
    const root = svg.toString('utf8', 0, svg.indexOf('>') + 1);
    const scale = (value: string | undefined) =>
        value === undefined ? undefined : PHYSICAL_LENGTH.test(value) ? 96 / 72 : 1;
    const x = scale(root.match(/\swidth="([^"]*)"/)?.[1]);
    const y = scale(root.match(/\sheight="([^"]*)"/)?.[1]);
    return { width: width * (x ?? y ?? 1), height: height * (y ?? x ?? 1) };
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
