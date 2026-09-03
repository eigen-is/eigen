import { CANVAS_PREVIEW_WIDTH } from '@workspace/lib/constants/preview';
import { type MediaResolver, readVectorFromDoc } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import type { TransformWarning } from '../document/transform/protocol';
import { framePages, renderCanvasPage } from '../export/canvas/render';
import { sanitizeExportHtml } from '../export/sanitize';
import { applyPreviewByteGuard, renderPreviewTruncatedMarker } from './preview-marker';
import { sanitizeSceneHtml } from './sanitize-scene';

// Materialized doc → the deck's first slides as compositor pages, the same HTML the PDF export
// prints. Runs inside the transform Worker (worker.ts owns execution; the main-thread orchestration
// lives in preview-document.ts). This module must not reach the Mount or the transform seam. Media
// resolves through the URL map the main thread prepared (the Worker has no Mount).
//
// Filtered on the two levels eigenvector-render.ts documents: each rich-text body through the shared
// ref restriction first, then the assembled page as a whole, with the media URLs allow-listed so the
// compositor's own hrefs survive.
const PREVIEW_MAX_SLIDES = 8;

export function renderEigenslidesPreviewBody(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const resolveMedia: MediaResolver = (mediaName) => mediaUrls.get(mediaName) ?? null;
    const pages = framePages(sanitizeSceneHtml(readVectorFromDoc(doc)), resolveMedia);
    const warnings: TransformWarning[] = [];
    // A deck with no frames has no pages; the pane shows its own empty state. (Unlike a drawing, an
    // empty deck is not a state the editor can leave behind — it seeds a slide on first open.)
    if (pages.length === 0) return { body: '', warnings };

    const truncated = pages.length > PREVIEW_MAX_SLIDES;
    const scale = CANVAS_PREVIEW_WIDTH / pages[0].width;
    const html = pages
        .slice(0, PREVIEW_MAX_SLIDES)
        .map((page) => renderCanvasPage(page, scale, resolveMedia))
        .join('');
    const body = sanitizeExportHtml(truncated ? `${html}${renderPreviewTruncatedMarker()}` : html, {
        allowedRefs: new Set(mediaUrls.values()),
    });
    return { body: applyPreviewByteGuard(body, warnings), warnings };
}
