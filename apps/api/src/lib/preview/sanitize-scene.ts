import type { VectorScene } from '@workspace/lib/vector';
import { sanitizeExportHtml } from '../export/sanitize';

// Every element that carries an `html` body, with that body filtered: DOMPurify plus the shared
// restriction to data: refs, so nothing a collaborator wrote in it can fetch from anywhere.
export function sanitizeSceneHtml(scene: VectorScene): VectorScene {
    return {
        ...scene,
        elements: scene.elements.map((el) => ('html' in el ? { ...el, html: sanitizeExportHtml(el.html) } : el)),
    };
}
