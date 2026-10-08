/// <reference path="../modules.d.ts" />
import type { JSONContent } from '@tiptap/core';
import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import {
    DEFAULT_PAGE_SETUP,
    type FigureAttrs,
    getDocExtensions,
    pageStylesheet,
    pageTwips,
} from '@workspace/lib/docs/eigendoc';
import { escapeHtml } from '@workspace/lib/html';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { common, createLowlight } from 'lowlight';
import type * as Y from 'yjs';
import { readEigendocFromDoc } from '../../document/doc';
import { toDataUriMap } from '../../document/media';
import {
    type EigendocExportFormat,
    type TransformMedia,
    type TransformWarning,
    toTransferableBuffer,
    toTransferableText,
} from '../../document/transform/protocol';
import { FONT_STACK_MONO, FONT_STACK_SANS } from '../font-stacks';
import { getFontCSS } from '../fonts';
import { sanitizeExportHtml } from '../sanitize';
import { PROSE_CSS } from './prose-css';
import { renderCodeBlockNode, renderFigureNode, renderTaskItemNode } from './render';

// Materialized doc + prepared media → export bytes. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread orchestration lives in export-document.ts).
// This module must not reach the Mount or the preview cache — the Worker imports it.
//
// Every format renders the same document by design: WeasyPrint and Turbodocx both
// consume exactly what the HTML download serves. Turbodocx loads lazily — it is an
// externalized dependency, and an HTML export must not evaluate it.
export async function renderEigendocExport(
    doc: Y.Doc,
    format: EigendocExportFormat,
    title: string,
    media: TransformMedia[],
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const html = renderEigendocDocument(readEigendocFromDoc(doc), toDataUriMap(media), title);
    if (format !== 'docx') return { data: toTransferableText(`<!DOCTYPE html>\n${html}`), warnings: [] };

    // Without the doctype: html-to-docx opens the body with an empty paragraph for it.
    const HTMLtoDOCX = (await import('@turbodocx/html-to-docx')).default;
    const docx = await HTMLtoDOCX(html, undefined, {
        title: stripEigenExtension(title),
        pageSize: { width: PAGE_TWIPS.width, height: PAGE_TWIPS.height },
        margins: PAGE_TWIPS.margin,
    });
    return { data: toTransferableBuffer(new Uint8Array(docx)), warnings: [] };
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

const PAGE_TWIPS = pageTwips(DEFAULT_PAGE_SETUP);

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
