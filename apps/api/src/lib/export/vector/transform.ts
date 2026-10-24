import { isTransparentColor, readVectorFromDoc } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import { ApiError } from '../../core/errors';
import { toDataUriMap } from '../../document/media';
import type { ExportMediaLoader, TransformWarning } from '../../document/transform/protocol';
import { toTransferableText } from '../../document/transform/protocol';
import { drawingPage, sceneMediaNames } from '../canvas/render';
import { canvasHtmlDocument } from '../canvas/transform';
import { sanitizeSceneHtml } from '../sanitize';

// A transparent drawing exports as white paper for PDF: WeasyPrint has no canvas behind the page.
const PDF_PAPER = '#ffffff';

// Materialized doc + prepared media → the PDF's HTML document: the drawing as compositor layers on a page sized to
// the artwork, rich text printing because it is an HTML div here. Runs inside the transform process (child.ts owns
// execution; the main-thread orchestration lives in export-document.ts). This module must not reach the Mount or the
// preview cache — the Worker imports it. A drawing's SVG is the editor's own (packages/ui's canvas image writer).
export async function renderEigenvectorExport(
    doc: Y.Doc,
    title: string,
    loadMedia: ExportMediaLoader,
): Promise<{ data: ArrayBuffer; warnings: TransformWarning[] }> {
    const scene = sanitizeSceneHtml(readVectorFromDoc(doc));
    const dataUriMap = toDataUriMap(await loadMedia(sceneMediaNames(scene)));
    const paperScene = isTransparentColor(scene.meta.background)
        ? { ...scene, meta: { ...scene.meta, background: PDF_PAPER } }
        : scene;
    const page = drawingPage(paperScene, (mediaName) => dataUriMap.get(mediaName) ?? null);
    // Nothing to print, and nothing to size a page from.
    if (!page) throw new ApiError(400, 'The drawing is empty');
    // The shared canvas document sanitizes the assembled body and owns the @page rule, the fonts and
    // the reset — a deck's pages and a drawing's single page leave through the same wrapper.
    const html = canvasHtmlDocument({ title, pages: [page], mode: 'pdf' });
    return { data: toTransferableText(html), warnings: [] };
}
