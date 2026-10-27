// The standalone document for pages of compositor layers, such as a deck's HTML and PDF and a drawing's PDF, so they
// share one @page rule, one font block and one reset. Also a deck's HTML and PDF export, one page per frame. Runs in
// the transform process, so it reaches no Mount and no preview cache.

import { ptToPx } from '@workspace/lib/docs/eigendoc';
import type { MediaResolver } from '@workspace/lib/vector';
import { readVectorFromDoc, round, slidePxToPt } from '@workspace/lib/vector';
import canvasTextCSSRaw from '@workspace/ui/styles/canvas-text.css' with { type: 'text' };
import type * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import { FONT_STACK_SANS } from '../../document/font-stacks';
import { toDataUriMap } from '../../document/media';
import type {
    DocumentExportFormat,
    ExportMediaLoader,
    ExportTransformResult,
    TransformWarning,
} from '../../document/transform/protocol';
import { htmlExportMode, toTransferableText } from '../../document/transform/protocol';
import { exportHtmlDocument } from '../html-document';
import { sanitizeSceneHtml } from '../sanitize';
import { MAX_PDF_PAGE_PX } from '../weasyprint';
import type { CanvasPage } from './render';
import { framePages, renderFittedPage, renderPrintPage, sceneMediaNames } from './render';

// A screen document scales its pages; a PDF document has no scale to take, because it lays each page out
// at 1:1 and htmlToPdf's zoom scales it onto the sheet.
type CanvasDocumentOptions = { title: string; pages: CanvasPage[]; resolveMedia?: MediaResolver } & (
    | { mode: 'screen'; scale: number }
    | { mode: 'pdf' }
);

export function canvasHtmlDocument(opts: CanvasDocumentOptions): string {
    const { title, pages, resolveMedia } = opts;
    const pdf = opts.mode === 'pdf';
    // The screen document wraps each page in the shared fit box, so a downloaded deck reads on a phone. The layers
    // inside stay in scene pixels. The PDF has no viewport, as WeasyPrint gives each page a sheet, so its pages stay
    // unwrapped, laid out where they print.
    const scale = pdf ? 1 : opts.scale;
    const rendered = pages.map((page) =>
        pdf ? renderPrintPage(page, resolveMedia) : renderFittedPage(page, scale, resolveMedia),
    );
    // Every page in a document is the same size (a deck has one slide size; a drawing has one page), and it
    // is rounded exactly as the page box is — a sheet a fraction narrower than its content is an extra
    // blank page in WeasyPrint. Callers guarantee at least one page.
    const width = round(pages[0].width * scale);
    const height = round(pages[0].height * scale);
    // A rich-text box's raw HTML was filtered at the scene; the builder sanitizes the assembled body. No ADD_TAGS: the
    // compositor emits ordinary HTML, never a foreignObject.
    const body = rendered.join('');
    const css = pdf ? pdfCss(width, height) : screenCss(width);
    return exportHtmlDocument({
        title,
        css: `${SHARED_CSS}${css}${canvasTextCSSRaw}`,
        body: pdf ? body : `<div class="deck">${body}</div>`,
        viewport: true,
    });
}

// Materialized doc + prepared media → a deck's HTML or PDF document: one page per frame.
export async function renderEigenslidesHtml(
    doc: Y.Doc,
    format: DocumentExportFormat,
    title: string,
    loadMedia: ExportMediaLoader,
): Promise<ExportTransformResult & { warnings: TransformWarning[] }> {
    // Rich text is filtered per element before the compositor lays it out, so a <style> block in a
    // text box cannot reach the document — which carries the generated @font-face rules of its own.
    const scene = sanitizeSceneHtml(readVectorFromDoc(doc));
    const dataUriMap = toDataUriMap(await loadMedia(sceneMediaNames(scene)));
    const resolveMedia: MediaResolver = (mediaName) => dataUriMap.get(mediaName) ?? null;
    const pages = framePages(scene, resolveMedia);
    // Nothing to print, and nothing to size a page from.
    if (pages.length === 0) throw new ApiError(400, 'The deck is empty');
    // A deck page is the deck's own width: a new deck's 960 pt is 1280 px at 96 dpi, so its 1920 px frame shows and
    // prints at 2/3. The screen document scales its pages by it. The PDF document lays them out at 1:1, and the scale
    // is the zoom htmlToPdf hands WeasyPrint.
    const scale = ptToPx(slidePxToPt(1, scene.meta.slideWidth));
    if (htmlExportMode(format) === 'pdf') {
        const html = canvasHtmlDocument({ title, pages, mode: 'pdf', resolveMedia });
        return { data: toTransferableText(html), zoom: scale, warnings: [] };
    }
    const html = canvasHtmlDocument({ title, pages, mode: 'screen', scale, resolveMedia });
    return { data: toTransferableText(html), warnings: [] };
}

// The reset zeroes every padding, which would otherwise pull a rich-text box's list markers outside
// its box — canvas-text.css puts that one back.
const SHARED_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
img { display: block; max-width: 100%; }
svg { display: block; }
`;

// The viewport widths of the fit box's fallback ladder, for a browser that cannot divide `100cqw` by a length.
const FALLBACK_BREAKPOINTS = [960, 768, 640, 480, 360];

// The narrowest viewport the ladder serves. The bottom step has no lower breakpoint — it applies all
// the way down — so this is the width it must fit, or a phone crops the page it was meant to save.
const NARROWEST_VIEWPORT = 320;

// The body's padding is 2rem a side, so a page gets the viewport less 64px. A step is sized for the narrow end of its
// range, as `max-width: 960px` still applies at 769px, and rounded down, so a page scales a little small rather than
// overflowing.
function fallbackLadder(width: number): string {
    return FALLBACK_BREAKPOINTS.map((breakpoint, i) => {
        const narrowest = (FALLBACK_BREAKPOINTS[i + 1] ?? NARROWEST_VIEWPORT - 1) + 1;
        const scale = Math.floor((Math.min(narrowest - 64, width) / width) * 1000) / 1000;
        return `@media (max-width: ${breakpoint}px) {
    .page-fit > .canvas-page { transform: scale(${scale}); }
}`;
    }).join('\n');
}

// A page column, centered, with print rules: the deck's HTML download. The `.page-fit` rules mirror the app's, which a
// standalone document cannot import, and renderFittedPage's custom properties keep the two boxes alike. The ladder
// comes first, so a browser that cannot read the `100cqw / <n>px` division after it keeps the ladder's scale.
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
@page { size: ${Math.min(width, MAX_PDF_PAGE_PX)}px ${Math.min(height, MAX_PDF_PAGE_PX)}px; margin: 0; }
body { font-family: ${FONT_STACK_SANS}; }
.canvas-page { break-after: page; }
.canvas-page:last-child { break-after: auto; }
`;
}
