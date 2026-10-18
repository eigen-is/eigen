import type { JSONContent } from '@tiptap/core';
import {
    BAND_DISTANCE_MM,
    BAND_ROOTS,
    type BandRoot,
    PAGE_BAND_CLASS,
    PAGE_BREAK_CLASS,
    type PageSetup,
    pageStylesheet,
    readFigureAttrs,
} from '@workspace/lib/docs/eigendoc';
import type * as Y from 'yjs';
import { readEigendocBands, readEigendocFromDoc, readEigendocPage } from '../../document/doc';
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
import { DOCX_IMAGE_MAX_SIZE, encodeDocxImage, figureMediaKey } from './docx-image';
import { renderDocHtml, withAbsoluteLinks } from './render';
import type { DocxMedia } from './to-docx';

// Materialized doc + prepared media → export bytes. Runs inside the transform process
// (child.ts owns execution; the main-thread orchestration lives in export-document.ts).
// This module must not reach the Mount or the preview cache — the child imports it.
//
// HTML and PDF render the same document by design: WeasyPrint consumes what the HTML download
// serves, but for the small caps the PDF fakes (render.ts). The docx is written from the JSON by
// to-docx.ts, which loads lazily so an HTML export never evaluates it, its styles or its fonts.
export async function renderEigendocExport(
    doc: Y.Doc,
    format: EigendocExportFormat,
    title: string,
    media: ExportMedia[],
    publicOrigin: string | undefined,
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const json = readEigendocFromDoc(doc);
    const page = readEigendocPage(doc);
    const bands = readEigendocBands(doc);
    if (format === 'docx') {
        const { eigendocToDocx } = await import('./to-docx');
        const pasted = await pastedFigureMedia([json, ...Object.values(bands)]);
        const docxMedia = await withSvgFallbacks([...media, ...pasted]);
        return {
            data: toTransferableBuffer(await eigendocToDocx(json, bands, page, docxMedia, title, publicOrigin)),
            warnings: [],
        };
    }
    const dataUriMap = toDataUriMap(media);
    const pdf = htmlExportMode(format) === 'pdf';
    const prose = (content: JSONContent, className = 'eigen-prose tiptap') =>
        `<article class="${className}">${renderDocHtml(
            withAbsoluteLinks(content, publicOrigin),
            (mediaName, src) => (mediaName ? (dataUriMap.get(mediaName) ?? null) : src),
            { synthesizeSmallCaps: pdf, pageCounters: pdf },
        )}</article>`;
    const band = (root: BandRoot) => {
        const content = bands[root];
        return content
            ? `<div class="band-${root}">${prose(content, `eigen-prose tiptap ${PAGE_BAND_CLASS}`)}</div>`
            : '';
    };
    // Browsers ignore running(), so the download shows each band where the long page does: page 1's header on top, the
    // other pages' footer at the end.
    const body = pdf
        ? `${BAND_ROOTS.map(band).join('')}${prose(json)}`
        : `${band(page.differentFirstPage ? 'headerFirst' : 'header')}${prose(json)}${band('footer')}`;
    const html = exportHtmlDocument({
        title,
        css: `${PROSE_CSS}${printExtras(page)}${pdf && Object.keys(bands).length > 0 ? bandsCss(page) : ''}`,
        body: `<div class="page">${body}</div>`,
    });
    return { data: toTransferableText(html), warnings: [] };
}

// A figure pasted with a data: src has no media file, and the main thread never reads the doc, so each src is decoded
// here, once, through the encode a media file takes; an SVG through the sanitizer the main thread's media took.
async function pastedFigureMedia(roots: JSONContent[]): Promise<ExportMedia[]> {
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
    for (const root of roots) visit(root);
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

function printExtras(page: PageSetup): string {
    return `
/* The docs page as the editor draws it; on paper @page draws the margins */
${pageStylesheet(page, '.page')}

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

/* Task list checkboxes — explicit sizing to match editor (16px) */
ul[data-type="taskList"] li > label input[type="checkbox"] {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: #2563eb;
}
`;
}
