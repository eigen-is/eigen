import { escapeHtml } from '@workspace/lib/html';
import type { DeckData } from '@workspace/lib/slides';
// CSS embedded as string at build time by Bun's bundler — no runtime file resolution needed
import slideTextCSSRaw from '@workspace/ui/styles/canvas-text.css' with { type: 'text' };
import type * as Y from 'yjs';
import { toDataUriMap } from '../../document/media';
import { readDeckFromDoc } from '../../document/slides';
import {
    type DocumentExportFormat,
    type TransformMedia,
    type TransformWarning,
    toTransferableText,
} from '../../document/transform/protocol';
import { FONT_STACK_SANS } from '../font-stacks';
import { getFontCSS } from '../fonts';
import type { SizeUnit } from '../render-types';
import { sanitizeExportHtml } from '../sanitize';
import { fixedSizeUnit, renderDeckHtml, responsiveSizeUnit } from './render';

// 16:9 landscape page: 254mm x 142.875mm ~ 960 x 540 px at 96dpi
const PAGE_WIDTH_PX = 960;
const PAGE_HEIGHT_PX = 540;

// Materialized doc + prepared media → export bytes. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread orchestration lives in export-document.ts).
// This module must not reach the Mount or the preview cache — the Worker imports it.
export function renderEigenslidesExport(
    doc: Y.Doc,
    format: DocumentExportFormat,
    title: string,
    media: TransformMedia[],
): { data: ArrayBuffer; warnings: TransformWarning[] } {
    const html = renderDeckDocument(readDeckFromDoc(doc), toDataUriMap(media), title, format);
    return { data: toTransferableText(html), warnings: [] };
}

function renderDeckDocument(
    deck: DeckData,
    dataUriMap: Map<string, string>,
    title: string,
    format: DocumentExportFormat,
): string {
    const isPdf = format === 'pdf-html';
    const sizeUnit: SizeUnit = isPdf ? fixedSizeUnit(PAGE_WIDTH_PX, PAGE_HEIGHT_PX) : responsiveSizeUnit;
    const slideOptions = isPdf
        ? { fillPage: true, pageWidthPx: PAGE_WIDTH_PX, pageHeightPx: PAGE_HEIGHT_PX }
        : undefined;
    const slidesHtml = renderDeckHtml(deck, sizeUnit, (mediaName) => dataUriMap.get(mediaName) ?? null, slideOptions);
    // Sanitize the assembled body exactly like the preview surface (eigenslides-render.ts) —
    // defence in depth over render.ts's per-value escaping, so the download/print surface is
    // as guarded as the preview.
    const sanitized = sanitizeExportHtml(slidesHtml);

    return wrapInDocument(title, sanitized, isPdf);
}

function wrapInDocument(title: string, slidesHtml: string, isPdf: boolean): string {
    const css = isPdf ? PDF_CSS : SCREEN_CSS;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${css}${slideTextCSSRaw}</style>
</head>
<body>
    ${isPdf ? slidesHtml : `<div class="deck">${slidesHtml}</div>`}
</body>
</html>`;
}

const SHARED_RESET = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
img { display: block; max-width: 100%; }
`;

const SCREEN_CSS = `${SHARED_RESET}
body {
    font-family: ${FONT_STACK_SANS};
    background: #f5f5f5;
    margin: 0;
    padding: 2rem;
}

.deck {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
}

.slide {
    max-width: 960px;
    width: 100%;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    border-radius: 4px;
}

@media print {
    body { background: none; padding: 0; }
    .deck { gap: 0; }
    .slide {
        max-width: none;
        width: 100%;
        height: 100vh;
        box-shadow: none;
        border-radius: 0;
        page-break-after: always;
        aspect-ratio: auto;
        container-type: size;
    }
    .slide:last-child { page-break-after: auto; }
}
`;

const PDF_CSS = `${SHARED_RESET}
@page {
    size: 254mm 142.875mm;
    margin: 0;
}

body {
    font-family: ${FONT_STACK_SANS};
    margin: 0;
    padding: 0;
}

.slide {
    page-break-after: always;
}

.slide:last-child {
    page-break-after: auto;
}
`;
