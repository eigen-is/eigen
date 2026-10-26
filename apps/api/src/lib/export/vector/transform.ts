// A drawing's PDF export inside the transform process: the drawing as compositor layers on one page sized to the
// artwork, its rich text printing as HTML. Its only export is the PDF, as a drawing's SVG is written in the editor.
// It reaches no Mount and no preview cache.

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
    const html = canvasHtmlDocument({ title, pages: [page], mode: 'pdf' });
    return { data: toTransferableText(html), warnings: [] };
}
