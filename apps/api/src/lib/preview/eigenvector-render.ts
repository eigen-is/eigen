import { readVectorFromDoc, sceneToSvg, type VectorScene } from '@workspace/lib/vector';
import DOMPurify from 'isomorphic-dompurify';
import type * as Y from 'yjs';
import type { TransformWarning } from '../document/transform/protocol';

// Materialized doc → the drawing's own SVG, served as-is like any other SVG preview
// (getScreenPreview keeps SVGs unrasterized). Runs inside the transform Worker
// (worker.ts owns execution; the main-thread orchestration lives in preview-document.ts).
// This module must not reach the Mount or the transform seam — the Worker imports it, and
// sceneToSvg's roughjs/perfect-freehand deps stay DOM-free. Media resolves through the URL
// map the main thread prepared (the Worker has no Mount).
//
// The reader is the trust boundary for every scalar field (XML-invalid characters stripped, colours
// reduced to hex or 'transparent', coordinates clamped) — but NOT for a rich-text box's `html`, which
// it caps and cleans without filtering tags, so each body goes through DOMPurify here, exactly as the
// slides renderer does with a text object's HTML. Everything else in this body is built by the
// serializer itself; no byte guard, because injecting a truncated-HTML marker would only corrupt the SVG.
export function renderEigenvectorPreview(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const scene = sanitizeRichText(readVectorFromDoc(doc));
    const body = sceneToSvg(scene, { resolveMedia: (mediaName) => mediaUrls.get(mediaName) ?? null });
    return { body, warnings: [] };
}

// Every element that carries an `html` body, with that body filtered. Sanitizing the assembled document
// instead would strip the `eigen-media:` hrefs the preview resolves through the embed route.
function sanitizeRichText(scene: VectorScene): VectorScene {
    return {
        ...scene,
        elements: scene.elements.map((el) => ('html' in el ? { ...el, html: DOMPurify.sanitize(el.html) } : el)),
    };
}
