// A drawing's preview body: the drawing as one compositor page, the same HTML the PDF export prints. It runs in the
// transform process, so it reaches neither the Mount nor the transform seam, and its media resolves through the URL
// map the main thread prepared.

import { CANVAS_PREVIEW_HEIGHT, CANVAS_PREVIEW_WIDTH } from '@workspace/lib/constants/preview';
import { readVectorFromDoc } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import type { TransformWarning } from '../document/transform/protocol';
import type { CanvasPage } from '../export/canvas/render';
import { drawingPage, emptyPage, renderFittedPage, sceneBackground } from '../export/canvas/render';
import { sanitizeExportHtml, sanitizeSceneHtml } from '../export/sanitize';
import { applyPreviewByteGuard, renderPreviewTruncatedMarker } from './preview-marker';
import { capPreviewElements } from './preview-scene';

const EMPTY_PREVIEW_HEIGHT = 120;

// The body renders as live DOM in the drive hero and the preview pane, so it is filtered twice. The reader is the trust
// boundary for every scalar field: it strips XML-invalid characters, reduces colors to hex or 'transparent' and clamps
// coordinates. It only caps and cleans the `html` of a text box or a shape, without filtering tags. So that html first
// goes through the shared ref restriction, and a collaborator's `<img src=https://…>` or `background:url(https://…)`
// cannot beacon every viewer. The assembled page then goes through DOMPurify as a whole, after the compositor has added
// its own media hrefs and `url(#…)` gradient refs, which must survive.
export function renderEigenvectorPreviewBody(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const full = readVectorFromDoc(doc);
    const { elements, truncated } = capPreviewElements(full);
    const scene = sanitizeSceneHtml({ ...full, elements });
    const page = drawingPage(scene, (mediaName) => mediaUrls.get(mediaName) ?? null);
    // An empty drawing still previews as a page: getOrCacheText stores only a non-empty body, so
    // nothing here would leave an emptied drawing serving the preview it had when it had content.
    const html = page
        ? renderPreviewPage(page)
        : renderFittedPage(emptyPage(sceneBackground(scene), CANVAS_PREVIEW_WIDTH, EMPTY_PREVIEW_HEIGHT), 1);
    const warnings: TransformWarning[] = [];
    const sanitized = sanitizeExportHtml(truncated ? `${html}${renderPreviewTruncatedMarker()}` : html, {
        allowedRefs: new Set(mediaUrls.values()),
    });
    return { body: applyPreviewByteGuard(sanitized, warnings), warnings };
}

function renderPreviewPage(page: CanvasPage): string {
    // Fit the whole page: scaled on width alone, a tall narrow drawing magnifies unboundedly.
    const scale = Math.min(CANVAS_PREVIEW_WIDTH / page.width, CANVAS_PREVIEW_HEIGHT / page.height);
    // A page fitted by height comes out narrower than CANVAS_PREVIEW_WIDTH, while the drive preview scales the body
    // from exactly that width. So the page widens in scene units and its origin moves by half the difference, and the
    // box comes out full width with the drawing centered in it.
    const width = CANVAS_PREVIEW_WIDTH / scale;
    return renderFittedPage({ ...page, width, originX: page.originX - (width - page.width) / 2 }, scale);
}
