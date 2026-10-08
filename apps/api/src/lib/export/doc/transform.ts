import type { JSONContent } from '@tiptap/core';
import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import { DEFAULT_PAGE_SETUP, type FigureAttrs, getDocExtensions, pageStylesheet } from '@workspace/lib/docs/eigendoc';
import { escapeHtml } from '@workspace/lib/html';
import { common, createLowlight } from 'lowlight';
import type * as Y from 'yjs';
import { readEigendocFromDoc } from '../../document/doc';
import { toDataUriMap } from '../../document/media';
import {
    type EigendocExportFormat,
    type ExportMedia,
    type TransformWarning,
    toTransferableBuffer,
    toTransferableText,
} from '../../document/transform/protocol';
import type { SCREEN_PREVIEW_MAX_SIZE } from '../../preview/preview-cache';
import { FONT_STACK_MONO, FONT_STACK_SANS } from '../font-stacks';
import { getFontCSS } from '../fonts';
import { sanitizeExportHtml } from '../sanitize';
import { PROSE_CSS } from './prose-css';
import { renderCodeBlockNode, renderFigureNode, renderTaskItemNode } from './render';

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
    const html = renderEigendocDocument(json, toDataUriMap(media), title);
    return { data: toTransferableText(`<!DOCTYPE html>\n${html}`), warnings: [] };
}

// The screen preview's largest side. The Worker never loads preview-cache, so its type pins the value.
const SVG_FALLBACK_MAX_SIZE: typeof SCREEN_PREVIEW_MAX_SIZE = 2560;

// The PNG every reader but Word draws, from the sanitized XML the svgBlip carries, so both draw one picture. One at a
// time, for one decode's memory; sharp loads only for an SVG.
async function withSvgFallbacks(media: ExportMedia[]): Promise<ExportMedia[]> {
    if (!media.some((item) => item.contentType === 'image/svg+xml')) return media;
    const { default: sharp } = await import('sharp');
    const prepared: ExportMedia[] = [];
    for (const item of media) {
        if (item.contentType !== 'image/svg+xml') {
            prepared.push(item);
            continue;
        }
        try {
            const image = sharp(Buffer.from(item.data));
            const { width, height } = await image.metadata();
            const png = await image
                .resize(SVG_FALLBACK_MAX_SIZE, SVG_FALLBACK_MAX_SIZE, { fit: 'inside', withoutEnlargement: true })
                .png()
                .toBuffer();
            prepared.push({ ...item, png: toTransferableBuffer(png), width, height });
        } catch {
            // One librsvg can't read leaves the docx, as an image no reader draws.
        }
    }
    return prepared;
}

const lowlight = createLowlight(common);
const extensions = getDocExtensions({ lowlight });

function renderEigendocDocument(json: JSONContent, dataUriMap: Map<string, string>, title: string): string {
    const bodyHtml = renderToHTMLString({
        content: json,
        extensions,
        options: {
            nodeMapping: {
                codeBlock: ({ node }) => renderCodeBlockNode(node, lowlight),
                taskItem: ({ node, children }) => renderTaskItemNode(node, children),
                figure: ({ node }: { node: { attrs: FigureAttrs } }) =>
                    renderFigureNode(node.attrs, (mediaName, src) =>
                        mediaName ? (dataUriMap.get(mediaName) ?? null) : src,
                    ),
            },
        },
    });

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

body {
    font-family: ${FONT_STACK_SANS};
    color: #1a1a2e;
    margin: 0;
    padding: 0;
}

.page {
    max-width: 100%;
    margin: 0 auto;
    overflow-wrap: anywhere;
}

figure, table, pre, blockquote { page-break-inside: avoid; }

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
