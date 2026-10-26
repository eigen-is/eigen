// A point list as an element stores it, a JSON string of [x, y] pairs at 2 decimals, and the
// rounding and angle unit every stored length and angle uses. It imports nothing at runtime, so the
// charts layout and any other module can use it without loading the kinds that geometry dispatches to.

import type { Bounds, Point } from './geometry';

export const DEG_TO_RAD = Math.PI / 180;

export function parsePoints(points: string): Point[] {
    let raw: unknown;
    try {
        raw = JSON.parse(points);
    } catch {
        return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: Point[] = [];
    for (const pair of raw) {
        if (!Array.isArray(pair)) return [];
        const [x, y] = pair;
        if (typeof x !== 'number' || typeof y !== 'number') return [];
        // A non-finite coord (e.g. 1e400 → Infinity via JSON overflow) drops just that point, not the
        // whole stroke — read-vector then clamps the survivors per axis.
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        out.push({ x, y });
    }
    return out;
}

export function serializePoints(points: Point[]): string {
    return JSON.stringify(points.map((p) => [round(p.x), round(p.y)]));
}

export function pointsBounds(points: Point[]): Bounds {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const { x, y } of points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY };
}

// 2-decimal rounding, the precision every serialized length uses: the stored point lists here and the
// SVG path data the kinds emit (Excalidraw's TO_FIXED_PRECISION, without the regex). `-0` collapses to
// `0` so two identical geometries can't serialize differently. `round3` (geometry) and `round4` (outline)
// are deliberately different precisions, not copies of this one.
export function round(n: number): number {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
}
