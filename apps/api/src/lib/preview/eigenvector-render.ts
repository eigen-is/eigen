import { readVectorFromDoc, sceneToSvg } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import type { TransformWarning } from '../document/transform/protocol';

// Materialized doc → the drawing's own SVG, served as-is like any other SVG preview
// (getScreenPreview keeps SVGs unrasterized). Runs inside the transform Worker
// (worker.ts owns execution; the main-thread orchestration lives in preview-document.ts).
// This module must not reach the Mount or the transform seam — the Worker imports it, and
// sceneToSvg's roughjs/perfect-freehand deps stay DOM-free. Media resolves through the URL
// map the main thread prepared (the Worker has no Mount).
//
// No DOMPurify and no byte guard here, unlike the HTML previews: this body is not HTML
// pasted into a page, it is an SVG image the serializer builds itself from fields
// read-vector already validated (XML-invalid characters stripped, colours reduced to hex
// or 'transparent', coordinates clamped), and injecting a truncated-HTML marker would
// only corrupt the SVG. The reader is the trust boundary for every consumer.
export function renderEigenvectorPreview(
    doc: Y.Doc,
    mediaUrls: Map<string, string>,
): { body: string; warnings: TransformWarning[] } {
    const scene = readVectorFromDoc(doc);
    const body = sceneToSvg(scene, { resolveMedia: (mediaName) => mediaUrls.get(mediaName) ?? null });
    return { body, warnings: [] };
}
