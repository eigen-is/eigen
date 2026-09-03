import { CANVAS_PREVIEW_HEIGHT, CANVAS_PREVIEW_WIDTH } from '@workspace/lib/constants/preview';
import { readVectorFromDoc } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import type { TransformWarning } from '../document/transform/protocol';
import { type CanvasPage, drawingPage, emptyPage, renderFittedPage } from '../export/canvas/render';
import { sanitizeExportHtml } from '../export/sanitize';
import { applyPreviewByteGuard } from './preview-marker';
import { sanitizeSceneHtml } from './sanitize-scene';

const EMPTY_PREVIEW_HEIGHT = 120;

// Materialized doc → the drawing as one compositor page, the same HTML the PDF export prints.
// Runs inside the transform Worker (worker.ts owns execution; the main-thread orchestration lives
// in preview-document.ts). This module must not reach the Mount or the transform seam — the Worker
// imports it, and the compositor's roughjs/perfect-freehand deps stay DOM-free. Media resolves
// through the URL map the main thread prepared (the Worker has no Mount).
//
// The body renders as live DOM in the drive hero and the preview pane, so it is filtered twice. The
// reader is the trust boundary for every scalar field (XML-invalid characters stripped, colours
// reduced to hex or 'transparent', coordinates clamped) but NOT for a rich-text box's `html`, which
// it caps and cleans without filtering tags: each of those goes through the shared ref restriction
// first, so a collaborator's `<img src=https://…>` or `background:url(https://…)` cannot beacon
// every viewer. The assembled page then goes through DOMPurify as a whole, after the compositor has
// added the media hrefs and `url(#…)` gradient refs of its own that must survive.
export function renderEigenvectorPreviewBody(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const scene = sanitizeSceneHtml(readVectorFromDoc(doc));
    const page = drawingPage(scene, (mediaName) => mediaUrls.get(mediaName) ?? null);
    // An empty drawing still previews as a page: getOrCacheText stores only a non-empty body, so
    // nothing here would leave an emptied drawing serving the preview it had when it had content.
    const html = page
        ? renderPreviewPage(page)
        : renderFittedPage(emptyPage(scene, CANVAS_PREVIEW_WIDTH, EMPTY_PREVIEW_HEIGHT), 1);
    const warnings: TransformWarning[] = [];
    const sanitized = sanitizeExportHtml(html, { allowedRefs: new Set(mediaUrls.values()) });
    return { body: applyPreviewByteGuard(sanitized, warnings), warnings };
}

function renderPreviewPage(page: CanvasPage): string {
    // Fit the whole page: scaled on width alone, a tall narrow drawing magnifies unboundedly.
    const scale = Math.min(CANVAS_PREVIEW_WIDTH / page.width, CANVAS_PREVIEW_HEIGHT / page.height);
    // A page fitted by height composes narrower than CANVAS_PREVIEW_WIDTH, and drive-preview.tsx
    // scales the body from exactly that intrinsic width. Widen the page in SCENE units and shift its
    // origin by half the difference: the box comes out full width with the drawing centred in it.
    const width = CANVAS_PREVIEW_WIDTH / scale;
    return renderFittedPage({ ...page, width, originX: page.originX - (width - page.width) / 2 }, scale);
}
