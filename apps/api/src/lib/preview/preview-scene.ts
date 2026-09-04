// The scene prep both canvas previews share: the element budget, then the per-element rich-text filter.
import { sceneReadingOrder, type VectorElement, type VectorScene } from '@workspace/lib/vector';
import { sanitizeExportHtml } from '../export/sanitize';

// A glance, not the whole canvas: like the doc's 20 blocks and the deck's 8 slides, so a scene with
// tens of thousands of elements cannot make the Worker generate a roughjs path for every one of
// them. One number for both canvas previews — a crowded slide costs what a crowded drawing costs.
const PREVIEW_MAX_ELEMENTS = 500;

// The elements a preview renders: the first in reading order — frame by frame, then z-order inside
// a frame. sceneLayers paints in z-order whatever it is given, so the slice needs no re-sorting.
// A drawing has no frames, so what survives is its bottom 500 in stacking order.
export function capPreviewElements(scene: VectorScene): { elements: VectorElement[]; truncated: boolean } {
    if (scene.elements.length <= PREVIEW_MAX_ELEMENTS) return { elements: scene.elements, truncated: false };
    return { elements: sceneReadingOrder(scene).slice(0, PREVIEW_MAX_ELEMENTS), truncated: true };
}

// A preview body is injected as live DOM in the drive hero and the lightbox, where a <style> block
// styles the whole app rather than the element that carries it — a blanked UI or an invisible overlay
// for everyone who browses the folder. Nothing a rich-text box legitimately holds is a style element.
// <link>, <meta> and <base> are not in DOMPurify's allowlist to begin with.
const PREVIEW_TAGS = { FORBID_TAGS: ['style'] };

// Every element that carries an `html` body, with that body filtered: DOMPurify plus the shared
// restriction to data: refs, so nothing a collaborator wrote in it can fetch from anywhere.
export function sanitizeSceneHtml(scene: VectorScene): VectorScene {
    return {
        ...scene,
        elements: scene.elements.map((el) =>
            'html' in el ? { ...el, html: sanitizeExportHtml(el.html, PREVIEW_TAGS) } : el,
        ),
    };
}
