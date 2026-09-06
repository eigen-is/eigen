import { CANVAS_PREVIEW_WIDTH } from '@workspace/lib/constants/preview';
import {
    DEFAULT_FRAME_BACKGROUND,
    FRAME_HEIGHT,
    FRAME_WIDTH,
    type MediaResolver,
    orderByFractionalIndex,
    parseBackgroundFill,
    readVectorFromDoc,
} from '@workspace/lib/vector';
import type * as Y from 'yjs';
import type { TransformWarning } from '../document/transform/protocol';
import { emptyPage, framePages, renderFittedPage } from '../export/canvas/render';
import { sanitizeExportHtml, sanitizeSceneHtml } from '../export/sanitize';
import { applyPreviewByteGuard, renderPreviewTruncatedMarker } from './preview-marker';
import { capPreviewElements } from './preview-scene';

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
    const full = readVectorFromDoc(doc);
    const warnings: TransformWarning[] = [];
    // Sliced BEFORE composing: framePages renders every frame's layers, so a 200-slide deck would pay
    // for 200 pages to serve 8 of them. The shown frames' elements then go through the budget the
    // drawing preview shares, so one crowded slide cannot cost what 200 slides were refused.
    const frames = orderByFractionalIndex(full.frames).slice(0, PREVIEW_MAX_SLIDES);
    const shown = new Set(frames.map((frame) => frame.id));
    const capped = capPreviewElements({
        ...full,
        frames,
        elements: full.elements.filter((el) => shown.has(el.frameId)),
    });
    const scene = sanitizeSceneHtml({ ...full, frames, elements: capped.elements });
    const pages = framePages(scene, resolveMedia);
    const scale = CANVAS_PREVIEW_WIDTH / FRAME_WIDTH;
    // A deck with no frames still previews as one blank slide: getOrCacheText caches only a non-empty
    // body, so an empty one would re-run the whole document transform on every request, forever.
    if (pages.length === 0) {
        const blank = emptyPage(parseBackgroundFill(DEFAULT_FRAME_BACKGROUND), FRAME_WIDTH, FRAME_HEIGHT);
        return { body: renderFittedPage(blank, scale), warnings };
    }

    const truncated = full.frames.length > PREVIEW_MAX_SLIDES || capped.truncated;
    // Fitted, not bare: the lightbox and the drive hero are narrower than the composed page, and the
    // shared .page-fit box is what scales it down for them.
    const html = pages.map((page) => renderFittedPage(page, scale, resolveMedia)).join('');
    const body = sanitizeExportHtml(truncated ? `${html}${renderPreviewTruncatedMarker()}` : html, {
        allowedRefs: new Set(mediaUrls.values()),
    });
    return { body: applyPreviewByteGuard(body, warnings), warnings };
}
