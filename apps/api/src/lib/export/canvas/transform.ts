import { escapeHtml } from '@workspace/lib/html';
import { FRAME_WIDTH, type MediaResolver, readVectorFromDoc, round } from '@workspace/lib/vector';
// CSS embedded as string at build time by Bun's bundler — no runtime file resolution needed
import canvasTextCSSRaw from '@workspace/ui/styles/canvas-text.css' with { type: 'text' };
import type * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import { toDataUriMap } from '../../document/media';
import {
    type DocumentExportFormat,
    type TransformMedia,
    type TransformWarning,
    toTransferableText,
} from '../../document/transform/protocol';
import { FONT_STACK_SANS } from '../font-stacks';
import { getFontCSS } from '../fonts';
import { sanitizeExportHtml, sanitizeSceneHtml } from '../sanitize';
import { type CanvasPage, framePages, renderCanvasPage, renderFittedPage } from './render';

// Standalone HTML for a page of compositor layers — the deck's HTML and PDF exports and the drawing's
// PDF all leave through here, so there is one @page rule, one font block and one reset instead of a
// copy per document type. Runs inside the transform Worker (worker.ts owns execution; the main-thread
// orchestration lives in export-document.ts): no Mount, no preview cache.
//
// 16:9 landscape page: 254mm x 142.875mm ~ 960 x 540 px at 96dpi. A frame is 1920x1080, so a deck
// prints at scale 0.5 — a @page of 1920px would be a 20-inch sheet.
const DECK_PAGE_WIDTH = 960;
const DECK_SCALE = DECK_PAGE_WIDTH / FRAME_WIDTH;

export function canvasHtmlDocument(opts: {
    title: string;
    pages: CanvasPage[];
    scale: number;
    mode: 'screen' | 'pdf';
    resolveMedia?: MediaResolver;
}): string {
    const { title, pages, scale, mode, resolveMedia } = opts;
    // The screen document wraps each fixed-size page in the shared fit box, so a downloaded deck reads
    // on a phone; the layers inside stay in scene pixels because that is what packages/lib authors.
    // The PDF document has no viewport to be responsive to — WeasyPrint gives each page a sheet — so
    // its pages stay unscaled and unwrapped.
    const rendered = pages.map((page) =>
        mode === 'pdf' ? renderCanvasPage(page, scale, resolveMedia) : renderFittedPage(page, scale, resolveMedia),
    );
    // Every page in a document is the same size (frames are constant; a drawing has one page), and it
    // is rounded exactly as renderCanvasPage rounds the page box — a sheet a fraction narrower than
    // its content is an extra blank page in WeasyPrint. Callers guarantee at least one page.
    const width = round(pages[0].width * scale);
    const height = round(pages[0].height * scale);
    // A collaborator can put arbitrary strings in a schemaless scene, so the assembled body runs
    // through the shared sanitizer (the documented SSRF closure); a rich-text box's raw HTML was
    // filtered at the scene. No ADD_TAGS: the compositor emits ordinary HTML, never a foreignObject.
    const body = sanitizeExportHtml(rendered.join(''));
    const css = mode === 'pdf' ? pdfCss(width, height) : screenCss(width);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${SHARED_CSS}${css}${canvasTextCSSRaw}</style>
</head>
<body>
    ${mode === 'pdf' ? body : `<div class="deck">${body}</div>`}
</body>
</html>`;
}

// Materialized doc + prepared media → export bytes for a deck: one page per frame.
export function renderEigenslidesExport(
    doc: Y.Doc,
    format: DocumentExportFormat,
    title: string,
    media: TransformMedia[],
): { data: ArrayBuffer; warnings: TransformWarning[] } {
    const dataUriMap = toDataUriMap(media);
    const resolveMedia: MediaResolver = (mediaName) => dataUriMap.get(mediaName) ?? null;
    // Rich text is filtered per element before the compositor lays it out, so a <style> block in a
    // text box cannot reach the document — which carries the generated @font-face rules of its own.
    const pages = framePages(sanitizeSceneHtml(readVectorFromDoc(doc)), resolveMedia);
    // Nothing to print, and nothing to size a page from.
    if (pages.length === 0) throw new ApiError(400, 'The deck is empty');
    const html = canvasHtmlDocument({
        title,
        pages,
        scale: DECK_SCALE,
        mode: format === 'pdf-html' ? 'pdf' : 'screen',
        resolveMedia,
    });
    return { data: toTransferableText(html), warnings: [] };
}

// The reset zeroes every padding, which would otherwise pull a rich-text box's list markers outside
// its box — canvas-text.css puts that one back.
const SHARED_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
img { display: block; max-width: 100%; }
svg { display: block; }
`;

// A page column, centred, with print rules — the deck's HTML download. The `.page-fit` rules mirror
// packages/ui/src/styles/globals.css: a standalone document cannot import the app stylesheet, and
// renderFittedPage's custom properties are what keep the two from drifting into different boxes.
// `100cqw / <n>px` is a length over a length, i.e. the plain number `scale()` wants — CSS Values 4,
// so the named viewport ladder is declared FIRST and a browser that cannot parse the division simply
// keeps it.
const FALLBACK_BREAKPOINTS = [960, 768, 640, 480, 360];

// The narrowest viewport the ladder serves. The bottom step has no lower breakpoint — it applies all
// the way down — so this is the width it must fit, or a phone crops the page it was meant to save.
const NARROWEST_VIEWPORT = 320;

// Body padding is 2rem a side, so a page gets the viewport minus 64px. A step must be sized for the
// NARROW end of its range — `max-width: 960px` still applies at 769px, so scaling it from 960 would
// clip — and rounded DOWN, so a page under-scales slightly rather than overflowing.
function floor3(value: number): number {
    return Math.floor(value * 1000) / 1000;
}

function fallbackLadder(width: number): string {
    return FALLBACK_BREAKPOINTS.map((breakpoint, i) => {
        const narrowest = (FALLBACK_BREAKPOINTS[i + 1] ?? NARROWEST_VIEWPORT - 1) + 1;
        return `@media (max-width: ${breakpoint}px) {
    .page-fit > .canvas-page { transform: scale(${floor3(Math.min(narrowest - 64, width) / width)}); }
}`;
    }).join('\n');
}

function screenCss(width: number): string {
    return `
body {
    font-family: ${FONT_STACK_SANS};
    background: #f5f5f5;
    padding: 2rem;
}

.deck {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
}

.page-fit {
    container-type: inline-size;
    width: 100%;
    max-width: var(--page-w);
    aspect-ratio: var(--page-ar);
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    border-radius: 4px;
}

.page-fit > .canvas-page { transform-origin: top left; }

${fallbackLadder(width)}

.page-fit > .canvas-page {
    transform: scale(calc(100cqw / var(--page-w)));
}

@media print {
    body { background: none; padding: 0; }
    .deck { gap: 0; }
    .page-fit { box-shadow: none; border-radius: 0; break-after: page; }
    .page-fit:last-child { break-after: auto; }
}
`;
}

function pdfCss(width: number, height: number): string {
    return `
@page { size: ${width}px ${height}px; margin: 0; }
body { font-family: ${FONT_STACK_SANS}; }
.canvas-page { break-after: page; }
.canvas-page:last-child { break-after: auto; }
`;
}
