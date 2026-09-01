// Freehand (pencil) gesture — pure stroke state + step functions the canvas hook drives. A stroke
// stays LOCAL (never Yjs) until pointer up, when the canvas writes ONE freedraw element through
// normalizeLinear. Points are kept relative to a fixed origin so the ink never jumps under
// the cursor mid-draw; the origin is folded into x/y only at finish.

import type { Point } from '@workspace/lib/vector';

// origin = the pointer-down scene point; points are relative to it, first is always [0,0]. Not
// normalized while drawing (min corner can drift as the stroke grows) — finish re-normalizes.
// `pressures` is the parallel per-point pen pressure (PointerEvent.pressure), index-aligned with points.
export type FreedrawStroke = { origin: Point; points: Point[]; pressures: number[] };

export function startFreedrawStroke(origin: Point, pressure: number): FreedrawStroke {
    return { origin, points: [{ x: 0, y: 0 }], pressures: [pressure] };
}

// Append each sampled scene point (relative to the origin) and its pressure (the parallel arrays share an
// index), skipping any within `minDist` scene units of the last kept point (≈1 screen px) — thins the
// sub-pixel samples coalesced events feed while a fast scribble still keeps its shape. The skip drops the
// point AND its pressure together, so the two arrays stay aligned through the whole capture.
export function extendFreedrawStroke(
    stroke: FreedrawStroke,
    scenePoints: Point[],
    pressures: number[],
    minDist: number,
): void {
    for (let i = 0; i < scenePoints.length; i++) {
        const s = scenePoints[i];
        const p = { x: s.x - stroke.origin.x, y: s.y - stroke.origin.y };
        const last = stroke.points[stroke.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < minDist) continue;
        stroke.points.push(p);
        stroke.pressures.push(pressures[i]);
    }
}
