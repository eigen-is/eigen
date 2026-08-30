// Eraser gesture — pure marking step. A swipe marks every element the pointer passes over by
// hit-testing at samples along the segment between moves (≈ 4 screen px apart) so a fast swipe has
// no gaps (R2.14); Alt un-marks re-touched elements. Marks are a local preview set — the canvas
// deletes them in ONE call on pointer up. No Yjs write happens here.

import { hitTestElement, type Point, type VectorElement } from '@workspace/lib/vector';

// Sample the segment `from → to` (or just `to` when there's no previous point) every `step` scene
// units and, for each element hit within `threshold`, add its id to `marked` — or remove it when
// `alt` (Excalidraw's restore). `marked` is mutated in place.
export function markErase(
    ordered: VectorElement[],
    from: Point | null,
    to: Point,
    threshold: number,
    step: number,
    alt: boolean,
    marked: Set<string>,
): void {
    const samples: Point[] = [];
    if (from) {
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const n = Math.max(1, Math.ceil(dist / step));
        for (let i = 1; i <= n; i++) {
            samples.push({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
        }
    } else {
        samples.push(to);
    }
    for (const s of samples) {
        for (const el of ordered) {
            if (!hitTestElement(el, s, threshold)) continue;
            if (alt) marked.delete(el.id);
            else marked.add(el.id);
        }
    }
}
