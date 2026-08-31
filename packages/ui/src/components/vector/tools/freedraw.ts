// Freehand (pencil) gesture — pure stroke state + step functions the canvas hook drives. A stroke
// stays LOCAL (never Yjs) until pointer up, when the canvas writes ONE freedraw element through
// normalizeLinear. Points are kept relative to a fixed origin so the ink never jumps under
// the cursor mid-draw; the origin is folded into x/y only at finish.

import type { Point } from '@workspace/lib/vector';

// origin = the pointer-down scene point; points are relative to it, first is always [0,0]. Not
// normalized while drawing (min corner can drift as the stroke grows) — finish re-normalizes.
export type FreedrawStroke = { origin: Point; points: Point[] };

export function startFreedrawStroke(origin: Point): FreedrawStroke {
    return { origin, points: [{ x: 0, y: 0 }] };
}

// Append each sampled scene point (relative to the origin), skipping any within `minDist` scene units
// of the last kept point (≈1 screen px) — thins the sub-pixel samples coalesced events feed while a
// fast scribble still keeps its shape.
export function extendFreedrawStroke(stroke: FreedrawStroke, scenePoints: Point[], minDist: number): void {
    for (const s of scenePoints) {
        const p = { x: s.x - stroke.origin.x, y: s.y - stroke.origin.y };
        const last = stroke.points[stroke.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < minDist) continue;
        stroke.points.push(p);
    }
}
