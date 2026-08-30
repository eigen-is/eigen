// Freehand (pencil) gesture — pure stroke state + step functions the canvas hook drives. A stroke
// stays LOCAL (never Yjs) until pointer up, when the canvas writes ONE freedraw element through
// normalizeLinear (R2.11). Points are kept relative to a fixed origin so the ink never jumps under
// the cursor mid-draw; the origin is folded into x/y only at finish.

import type { Point } from '@workspace/lib/vector';

// origin = the pointer-down scene point; points are relative to it, first is always [0,0]. Not
// normalized while drawing (min corner can drift as the stroke grows) — finish re-normalizes.
export type FreedrawStroke = { origin: Point; points: Point[] };

export function startFreedrawStroke(origin: Point): FreedrawStroke {
    return { origin, points: [{ x: 0, y: 0 }] };
}

// Append each sampled scene point (relative to the origin), skipping exact duplicates. Coalesced
// pointer events feed several points per move so a fast scribble keeps its shape (R2.11).
export function extendFreedrawStroke(stroke: FreedrawStroke, scenePoints: Point[]): void {
    for (const s of scenePoints) {
        const p = { x: s.x - stroke.origin.x, y: s.y - stroke.origin.y };
        const last = stroke.points[stroke.points.length - 1];
        if (last.x === p.x && last.y === p.y) continue;
        stroke.points.push(p);
    }
}
