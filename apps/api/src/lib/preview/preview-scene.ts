// The element budget both canvas previews share.
import { sceneReadingOrder, type VectorElement, type VectorScene } from '@workspace/lib/vector';

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
