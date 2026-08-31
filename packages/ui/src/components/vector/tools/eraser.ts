// Eraser gesture — pure marking step. A swipe marks every element the pointer passes over by
// hit-testing at samples along the segment between moves (≈ 4 screen px apart) so a fast swipe has
// no gaps (R2.14); Alt un-marks re-touched elements. Marks are a local preview set — the canvas
// deletes them in ONE call on pointer up. No Yjs write happens here.

import { hitTestElement, type Point, type VectorElement } from '@workspace/lib/vector';
import { arrowRouteOf } from '../arrow-route';

// Cap the samples per move so a huge pointer jump (or a swipe at extreme zoom) can't fan a single
// segment out into thousands of hit tests × every element; ≈4px spacing still holds for normal moves.
const MAX_SAMPLES = 512;

// Sample the segment `from → to` every `step` scene units (from = to on pointer down samples that one
// point) and, for each element hit within `threshold`, add its id to `marked` — or remove it when
// `alt` (Excalidraw's restore). `marked` is mutated in place; returns whether it actually changed, so
// the caller skips a re-render (and the Set allocation it forces) on a no-op move over empty space.
export function markErase(
    ordered: VectorElement[],
    from: Point,
    to: Point,
    threshold: number,
    step: number,
    alt: boolean,
    marked: Set<string>,
    byId?: Map<string, VectorElement>,
): boolean {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const n = Math.min(MAX_SAMPLES, Math.max(1, Math.ceil(dist / step)));
    let changed = false;
    for (let i = 1; i <= n; i++) {
        const s = { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n };
        for (const el of ordered) {
            // Already-marked elements need no re-test (add is idempotent) — this skips re-parsing a
            // freehand element's points on every sample. Alt (restore) still re-tests to un-mark.
            if (!alt && marked.has(el.id)) continue;
            if (!hitTestElement(el, s, threshold, arrowRouteOf(el, byId))) continue;
            if (alt) {
                if (marked.delete(el.id)) changed = true;
            } else {
                marked.add(el.id);
                changed = true;
            }
        }
    }
    return changed;
}
