import { CANVAS_PREVIEW_WIDTH } from '@workspace/lib/constants/preview';
import { readVectorFromDoc, type VectorScene } from '@workspace/lib/vector';
import DOMPurify from 'isomorphic-dompurify';
import type * as Y from 'yjs';
import type { TransformWarning } from '../document/transform/protocol';
import { drawingPage, renderCanvasPage } from '../export/canvas/render';
import { applyPreviewByteGuard } from './preview-marker';

// Materialized doc → the drawing as one compositor page, the same HTML the PDF export prints.
// Runs inside the transform Worker (worker.ts owns execution; the main-thread orchestration lives
// in preview-document.ts). This module must not reach the Mount or the transform seam — the Worker
// imports it, and the compositor's roughjs/perfect-freehand deps stay DOM-free. Media resolves
// through the URL map the main thread prepared (the Worker has no Mount).
//
// The reader is the trust boundary for every scalar field (XML-invalid characters stripped, colours
// reduced to hex or 'transparent', coordinates clamped) — but NOT for a rich-text box's `html`,
// which it caps and cleans without filtering tags. Each body therefore goes through DOMPurify here,
// per element rather than over the assembled page, so the page's own markup is never rewritten.
export function renderEigenvectorPreviewBody(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const scene = sanitizeRichText(readVectorFromDoc(doc));
    const page = drawingPage(scene, { resolveMedia: (mediaName) => mediaUrls.get(mediaName) ?? null });
    const warnings: TransformWarning[] = [];
    // An empty drawing has no bounds to size a page from; the pane shows its own empty state.
    if (!page) return { body: '', warnings };
    return {
        body: applyPreviewByteGuard(renderCanvasPage(page, CANVAS_PREVIEW_WIDTH / page.width), warnings),
        warnings,
    };
}

// Every element that carries an `html` body, with that body filtered.
function sanitizeRichText(scene: VectorScene): VectorScene {
    return {
        ...scene,
        elements: scene.elements.map((el) => ('html' in el ? { ...el, html: DOMPurify.sanitize(el.html) } : el)),
    };
}
