import type { JSONContent } from '@tiptap/core';
import { DEFAULT_PAGE_SETUP, PAGE_BREAK_CLASS, pageStylesheet } from '@workspace/lib/docs/eigendoc';
import { escapeHtml } from '@workspace/lib/html';
import type * as Y from 'yjs';
import { readEigendocFromDoc } from '../../document/doc';
import { FONT_STACK_MONO } from '../../document/font-stacks';
import { toDataUriMap } from '../../document/media';
import { PROSE_CSS } from '../../document/prose-css';
import {
    DOCX_IMAGE_MAX_SIZE,
    type EigendocExportFormat,
    type ExportMedia,
    type TransformWarning,
    toTransferableBuffer,
    toTransferableText,
} from '../../document/transform/protocol';
import { getFontCSS } from '../fonts';
import { sanitizeExportHtml } from '../sanitize';
import { renderDocHtml, withAbsoluteLinks } from './render';
import type { DocxMedia } from './to-docx';

// Materialized doc + prepared media → export bytes. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread orchestration lives in export-document.ts).
// This module must not reach the Mount or the preview cache — the Worker imports it.
//
// HTML and PDF render the same document by design: WeasyPrint consumes exactly what the
// HTML download serves. The docx is written from the JSON by to-docx.ts, which loads
// lazily so an HTML export never evaluates it, its styles or its fonts.
export async function renderEigendocExport(
    doc: Y.Doc,
    format: EigendocExportFormat,
    title: string,
    media: ExportMedia[],
    publicOrigin: string | undefined,
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const json = readEigendocFromDoc(doc);
    if (format === 'docx') {
        const { eigendocToDocx } = await import('./to-docx');
        const docxMedia = await withSvgFallbacks(media);
        return { data: toTransferableBuffer(await eigendocToDocx(json, docxMedia, title, publicOrigin)), warnings: [] };
    }
    const html = renderEigendocDocument(withAbsoluteLinks(json, publicOrigin), toDataUriMap(media), title);
    return { data: toTransferableText(`<!DOCTYPE html>\n${html}`), warnings: [] };
}

// The thumbnail Worker's per-image timeout (shared/thumbnails.ts), which the Worker graph cannot import. Worker.terminate()
// does not stop libvips, so this is what frees the one transform slot from a filter librsvg grinds through for minutes.
const SVG_FALLBACK_TIMEOUT_SECONDS = 30;

// The PNG a reader without SVG draws, from the sanitized XML the svgBlip carries, so both draw one picture. One at a
// time, for one decode's memory; sharp loads only for an SVG.
export async function withSvgFallbacks(
    media: ExportMedia[],
    timeoutSeconds = SVG_FALLBACK_TIMEOUT_SECONDS,
): Promise<DocxMedia[]> {
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
                .timeout({ seconds: timeoutSeconds })
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

function renderEigendocDocument(json: JSONContent, dataUriMap: Map<string, string>, title: string): string {
    const bodyHtml = renderDocHtml(json, (mediaName, src) => (mediaName ? (dataUriMap.get(mediaName) ?? null) : src));
    return wrapInDocument(title, sanitizeExportHtml(bodyHtml));
}

function wrapInDocument(title: string, bodyHtml: string): string {
    return `<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${PROSE_CSS}${PRINT_EXTRAS}</style>
</head>
<body>
    <div class="page"><article class="eigen-prose tiptap">${bodyHtml}</article></div>
</body>
</html>`;
}

const PRINT_EXTRAS = `
/* The docs page as the editor draws it; on paper @page draws the margins */
${pageStylesheet(DEFAULT_PAGE_SETUP, '.page')}

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

h1, h2, h3, h4, h5, h6, hr, blockquote, pre, table { clear: both; }

.has-text-align-center { text-align: center; }
.has-text-align-right { text-align: right; }
.has-text-align-left { text-align: left; }

pre code { white-space: pre-wrap; font-family: ${FONT_STACK_MONO}; }

/* Task list checkboxes — explicit sizing to match editor (16px) */
ul[data-type="taskList"] li > label input[type="checkbox"] {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: #2563eb;
}
`;
