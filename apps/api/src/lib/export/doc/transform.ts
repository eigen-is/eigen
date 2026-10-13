import { DEFAULT_PAGE_SETUP, PAGE_BREAK_CLASS, pageStylesheet } from '@workspace/lib/docs/eigendoc';
import type * as Y from 'yjs';
import { readEigendocFromDoc } from '../../document/doc';
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
import { withSvgFallbacks } from '../office-image';
import { renderDocHtml, withAbsoluteLinks } from './render';

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
    if (format === 'docx') {
        const { eigendocToDocx, pastedFigureMedia } = await import('./to-docx');
        const docxMedia = await withSvgFallbacks([...media, ...(await pastedFigureMedia(json))]);
        return { data: toTransferableBuffer(await eigendocToDocx(json, docxMedia, title, publicOrigin)), warnings: [] };
    }
    const dataUriMap = toDataUriMap(media);
    const body = renderDocHtml(
        withAbsoluteLinks(json, publicOrigin),
        (mediaName, src) => (mediaName ? (dataUriMap.get(mediaName) ?? null) : src),
        { synthesizeSmallCaps: htmlExportMode(format) === 'pdf' },
    );
    const html = exportHtmlDocument({
        title,
        css: `${PROSE_CSS}${PRINT_EXTRAS}`,
        body: `<div class="page"><article class="eigen-prose tiptap">${body}</article></div>`,
    });
    return { data: toTransferableText(html), warnings: [] };
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

pre code { white-space: pre-wrap; font-family: ${FONT_STACK_MONO}; }

/* Task list checkboxes — explicit sizing to match editor (16px) */
ul[data-type="taskList"] li > label input[type="checkbox"] {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: #2563eb;
}
`;
