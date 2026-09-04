// Line (poly-line) gesture — pure draft state + step functions. Two entry modes, both Excalidraw's:
// press-drag-release = a 2-point line; a click starts a multi-point line whose trailing
// point follows the cursor and each further click commits a point. The draft is written ONCE at
// finish. Parameterized by `type` so the arrow tool starts the draft with
// `type: 'arrow'` — no second implementation.

import { type Point, snapAngle } from '@workspace/lib/vector';

// The arrow tool reuses the whole line gesture, parameterized by `type` — no second implementation.
// The draft carries the type so a commit knows whether to write a line or a bindable arrow.
type LinearToolType = 'line' | 'arrow';

// origin = the first scene point; committed/trailing are relative to it (first committed is [0,0]).
// `mode` is 'pending' during the opening press (which becomes a drag-line or, on a no-move release,
// switches to 'multi'); 'multi' collects further clicks with a live trailing point.
export type LineDraft = {
    type: LinearToolType;
    origin: Point;
    committed: Point[];
    trailing: Point;
    mode: 'pending' | 'multi';
};

export function startLineDraft(type: LinearToolType, origin: Point): LineDraft {
    return { type, origin, committed: [{ x: 0, y: 0 }], trailing: { x: 0, y: 0 }, mode: 'pending' };
}

// Constrain the segment `from → to` to the nearest 15° step, preserving its length (Shift). Used for
// both the live trailing segment and a Shift-committed point.
export function snapSegment(from: Point, to: Point): Point {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return to;
    const rad = (snapAngle((Math.atan2(dy, dx) * 180) / Math.PI, 15) * Math.PI) / 180;
    return { x: from.x + len * Math.cos(rad), y: from.y + len * Math.sin(rad) };
}

// The polyline drawn for the live preview: the committed points plus the trailing cursor point.
export function previewPoints(draft: LineDraft): Point[] {
    return [...draft.committed, draft.trailing];
}

// Distinct-vertex count (rounded, matching the serialized precision) — a line needs ≥ 2 to be worth
// writing.
export function distinctCount(points: Point[]): number {
    const seen = new Set<string>();
    for (const p of points) seen.add(`${Math.round(p.x * 100)},${Math.round(p.y * 100)}`);
    return seen.size;
}
