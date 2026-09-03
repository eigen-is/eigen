// The one definition of a shape's edge: the renderer draws it and the docking math intersects it, so a
// bound arrow lands on the curve the user can see.
//
// Model: a rounded convex shape is the Minkowski sum `core ⊕ disc(radius)`, `core` = the shape inset by
// `radius`. Inflating by `gap` keeps the core and grows the disc: `core ⊕ disc(radius + gap)`. One routine
// serves rectangle and diamond — only the core polygon differs. `radius === 0` dispatches to the sharp
// offset so `corners: 'straight'` is bit-for-bit unchanged; the Minkowski model would instead give
// gap-rounded corners there (≤ gap·(√2−1) ≈ 2.5px at gap 6). That discontinuity is deliberate.

import type { Point } from './geometry';
import type { Corners } from './types';

export type OutlineBox = { x: number; y: number; width: number; height: number };
export type Seg = { a: Point; b: Point };

const EPS = 1e-7;
const PROPORTIONAL_RADIUS = 0.25;
const ADAPTIVE_RADIUS = 32;
// Excalidraw's exact ellipse-projection iteration seed. The literal 0.707 (not Math.SQRT1_2) is the point —
// matching it byte-for-byte keeps ellipseEdgeDistance identical to the source; the more precise constant
// drifts the result.
// biome-ignore lint/suspicious/noApproximativeNumericConstant: parity with Excalidraw's 0.707 seed
const ELLIPSE_SEED = 0.707;

// The `round` corner radius: the shape's INRADIUS — the largest radius that keeps the silhouette
// recognisable, degenerating exactly to the inscribed circle (or a pill, for a rect with w ≠ h).
//   rect:    min(w, h) / 2
//   diamond: (w·h) / (2·√(w² + h²))          [= a·b/√(a²+b²) with a = w/2, b = h/2]
export function roundRadius(box: OutlineBox, kind: 'rectangle' | 'diamond'): number {
    if (kind === 'rectangle') return Math.min(box.width, box.height) / 2;
    const a = box.width / 2;
    const b = box.height / 2;
    const d = Math.hypot(a, b);
    return d === 0 ? 0 : (a * b) / d;
}

// The inset "core" of a rounded rect: the box pulled in by `radius` on all four sides.
export function rectCore(box: OutlineBox, radius: number): Point[] {
    const r = clamp(radius, 0, roundRadius(box, 'rectangle'));
    return dedupe([
        { x: box.x + r, y: box.y + r },
        { x: box.x + box.width - r, y: box.y + r },
        { x: box.x + box.width - r, y: box.y + box.height - r },
        { x: box.x + r, y: box.y + box.height - r },
    ]);
}

// The inset core of a rounded diamond: a SIMILAR diamond scaled by k = 1 − radius / inradius, because
// offsetting every edge inward by `radius` scales the distance-from-centre-to-edge (= the inradius)
// by that factor. k = 0 ⇒ the core is the centre point ⇒ the shape is the inscribed circle.
export function diamondCore(box: OutlineBox, radius: number): Point[] {
    const a = box.width / 2;
    const b = box.height / 2;
    const inradius = roundRadius(box, 'diamond');
    if (inradius === 0) return [{ x: box.x + a, y: box.y + b }];
    const k = 1 - clamp(radius, 0, inradius) / inradius;
    const cx = box.x + a;
    const cy = box.y + b;
    return dedupe([
        { x: cx, y: cy - b * k },
        { x: cx + a * k, y: cy },
        { x: cx, y: cy + b * k },
        { x: cx - a * k, y: cy },
    ]);
}

// The outline as DATA, so one value serves both consumers: outlinePath draws it, outlineHits intersects
// it. `gap` is the docking inflation (0 when rendering).
export type OutlineShape =
    | { kind: 'rounded'; core: Point[]; radius: number }
    | { kind: 'polygon'; corners: Point[] }
    | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
    | { kind: 'polyline'; points: Point[] };

export function rectOutline(box: OutlineBox, radius: number, gap: number): OutlineShape {
    if (radius <= 0) return { kind: 'polygon', corners: sharpRectOffset(box, gap) };
    const r = clamp(radius, 0, roundRadius(box, 'rectangle'));
    return { kind: 'rounded', core: rectCore(box, r), radius: r + gap };
}

export function diamondOutline(box: OutlineBox, radius: number, gap: number): OutlineShape {
    if (box.width === 0 || box.height === 0) return { kind: 'polygon', corners: [] };
    if (radius <= 0) return { kind: 'polygon', corners: sharpDiamondOffset(box, gap) };
    const r = clamp(radius, 0, roundRadius(box, 'diamond'));
    return { kind: 'rounded', core: diamondCore(box, r), radius: r + gap };
}

export function ellipseOutline(box: OutlineBox, gap: number): OutlineShape {
    return {
        kind: 'ellipse',
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
        rx: box.width / 2 + gap,
        ry: box.height / 2 + gap,
    };
}

// An open path has no interior to dock to, so its outline is the path itself.
export function polylineOutline(points: Point[]): OutlineShape {
    return { kind: 'polyline', points };
}

export function outlineHits(shape: OutlineShape, a: Point, b: Point): Point[] {
    if (shape.kind === 'rounded') return coreHits({ a, b }, shape.core, shape.radius);
    if (shape.kind === 'polygon') return segSharpHits({ a, b }, shape.corners);
    if (shape.kind === 'ellipse') return segEllipseHits({ a, b }, shape.cx, shape.cy, shape.rx, shape.ry);
    const hits: Point[] = [];
    for (let i = 1; i < shape.points.length; i++) {
        const hit = segSegIntersect(a, b, shape.points[i - 1], shape.points[i]);
        if (hit) hits.push(hit);
    }
    return hits;
}

// Distance from a point to the outline. For core ⊕ disc(R) that is |dist(p, core) − R| with dist SIGNED —
// a point deep inside the core is further from the edge, not nearer. One definition, so a `round` rectangle
// picks its heading and its side from the curve it actually draws. An empty outline reads 0: a degenerate
// shape has no edge, and Infinity would poison the caller's cone bounds.
export function outlineDistance(shape: OutlineShape, p: Point): number {
    if (shape.kind === 'rounded') return Math.abs(coreDistance(p, shape.core) - shape.radius);
    if (shape.kind === 'ellipse') return ellipseEdgeDistance(shape, p);
    let best = Number.POSITIVE_INFINITY;
    if (shape.kind === 'polygon') {
        for (const [a, b] of coreEdges(shape.corners)) best = Math.min(best, distToSegment(p, a, b));
    } else {
        for (let i = 1; i < shape.points.length; i++) {
            best = Math.min(best, distToSegment(p, shape.points[i - 1], shape.points[i]));
        }
    }
    return Number.isFinite(best) ? best : 0;
}

// The stored corner intent → a radius in scene units. `curved` is Excalidraw's adaptive radius (the value
// today's renderer hard-codes); `round` is the shape's INRADIUS, the largest radius that keeps the
// silhouette. Kinds pass their own `kind`; nothing outside this module switches on an element type.
export function cornerRadius(
    el: { width: number; height: number; corners: Corners },
    kind: 'rectangle' | 'diamond' = 'rectangle',
): number {
    const box = { x: 0, y: 0, width: el.width, height: el.height };
    if (el.corners === 'straight' || el.width <= 0 || el.height <= 0) return 0;
    if (el.corners === 'round') return roundRadius(box, kind);
    return Math.min(Math.min(el.width, el.height) * PROPORTIONAL_RADIUS, ADAPTIVE_RADIUS, roundRadius(box, kind));
}

// --- the one intersection routine -------------------------------------------------------------
//
// The outline is the level set { p : dist(p, core) = R }. Every candidate is closed form (a linear
// segment∩segment, or the two roots of a quadratic for segment∩circle); the level-set predicate then
// keeps only the ones actually on the outline. That predicate replaces per-vertex normal-cone maths and
// stays correct when the core degenerates to a segment (pill) or a point (circle).
export function coreHits(seg: Seg, core: Point[], R: number): Point[] {
    if (R <= 0 || core.length === 0) return [];
    const candidates: Point[] = [];
    for (const v of core) candidates.push(...segCircleHits(seg, v, R));
    for (const [a, b] of coreEdges(core)) {
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < EPS) continue;
        const nx = -(b.y - a.y) / len;
        const ny = (b.x - a.x) / len;
        for (const s of [R, -R]) {
            const hit = segSegIntersect(
                seg.a,
                seg.b,
                { x: a.x + nx * s, y: a.y + ny * s },
                { x: b.x + nx * s, y: b.y + ny * s },
            );
            if (hit) candidates.push(hit);
        }
    }
    const hits: Point[] = [];
    for (const p of candidates) {
        if (Math.abs(distToCore(p, core) - R) > 1e-6) continue;
        if (!hits.some((h) => Math.abs(h.x - p.x) < 1e-9 && Math.abs(h.y - p.y) < 1e-9)) hits.push(p);
    }
    return hits;
}

function coreEdges(core: Point[]): [Point, Point][] {
    if (core.length < 2) return [];
    if (core.length === 2) return [[core[0], core[1]]];
    return core.map((v, i): [Point, Point] => [v, core[(i + 1) % core.length]]);
}

// Distance to the FILLED convex core, not to its boundary. TRAP: the boundary distance has a second
// level set INSIDE the core (the inward edge offsets), which would admit a phantom hit one radius short
// of the real outline — the level-set filter needs the region, so an interior point must read 0.
function distToCore(p: Point, core: Point[]): number {
    return Math.max(0, coreDistance(p, core));
}

// Signed distance to the core's boundary: negative inside. outlineDistance needs the sign (an interior
// point is core-distance PLUS the radius from the edge); coreHits needs it clamped at 0, see distToCore.
function coreDistance(p: Point, core: Point[]): number {
    if (core.length === 1) return Math.hypot(p.x - core[0].x, p.y - core[0].y);
    let best = Number.POSITIVE_INFINITY;
    for (const [a, b] of coreEdges(core)) best = Math.min(best, distToSegment(p, a, b));
    return core.length > 2 && insideConvex(p, core) ? -best : best;
}

function insideConvex(p: Point, poly: Point[]): boolean {
    let neg = false;
    let pos = false;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        if (cross < -EPS) neg = true;
        if (cross > EPS) pos = true;
    }
    return !(neg && pos);
}

// --- sharp offsets: the radius-0 path --------------------------------------------------------

export function sharpRectOffset(box: OutlineBox, gap: number): Point[] {
    return [
        { x: box.x - gap, y: box.y - gap },
        { x: box.x + box.width + gap, y: box.y - gap },
        { x: box.x + box.width + gap, y: box.y + box.height + gap },
        { x: box.x - gap, y: box.y + box.height + gap },
    ];
}

export function sharpDiamondOffset(box: OutlineBox, gap: number): Point[] {
    const ax = box.width / 2;
    const ay = box.height / 2;
    if (ax === 0 || ay === 0) return [];
    const diag = Math.hypot(ax, ay);
    const aInf = ax + (gap * diag) / ay;
    const bInf = ay + (gap * diag) / ax;
    const cx = box.x + ax;
    const cy = box.y + ay;
    return [
        { x: cx, y: cy - bInf },
        { x: cx + aInf, y: cy },
        { x: cx, y: cy + bInf },
        { x: cx - aInf, y: cy },
    ];
}

function segSharpHits(seg: Seg, corners: Point[]): Point[] {
    const hits: Point[] = [];
    for (let i = 0; i < corners.length; i++) {
        const hit = segSegIntersect(seg.a, seg.b, corners[i], corners[(i + 1) % corners.length]);
        if (hit) hits.push(hit);
    }
    return hits;
}

// --- SVG path strings ---------------------------------------------------------------------------
//
// Circular arcs (`A r r 0 0 1 …`) tangent to both adjacent edges, so the drawn curve IS the curve
// coreHits intersects. roughjs's gen.path normalizes `A` to cubics itself, for both the stroke and the
// pointsOnPath fill, so no caller pre-flattens.

export function roundedRectPath(box: OutlineBox, radius: number): string {
    const { x, y, width: w, height: h } = box;
    const r = clamp(radius, 0, roundRadius(box, 'rectangle'));
    if (r <= 0) return `M ${n(x)} ${n(y)} L ${n(x + w)} ${n(y)} L ${n(x + w)} ${n(y + h)} L ${n(x)} ${n(y + h)} Z`;
    const arc = (px: number, py: number) => `A ${n(r)} ${n(r)} 0 0 1 ${n(px)} ${n(py)}`;
    return [
        `M ${n(x + r)} ${n(y)}`,
        `L ${n(x + w - r)} ${n(y)}`,
        arc(x + w, y + r),
        `L ${n(x + w)} ${n(y + h - r)}`,
        arc(x + w - r, y + h),
        `L ${n(x + r)} ${n(y + h)}`,
        arc(x, y + h - r),
        `L ${n(x)} ${n(y + r)}`,
        arc(x + r, y),
        'Z',
    ].join(' ');
}

export function roundedDiamondPath(box: OutlineBox, radius: number): string {
    const a = box.width / 2;
    const b = box.height / 2;
    const cx = box.x + a;
    const cy = box.y + b;
    const r = clamp(radius, 0, roundRadius(box, 'diamond'));
    if (r <= 0) {
        const sharp = [
            { x: cx, y: cy - b },
            { x: cx + a, y: cy },
            { x: cx, y: cy + b },
            { x: cx - a, y: cy },
        ];
        return `${sharp.map((p, i) => `${i === 0 ? 'M' : 'L'} ${n(p.x)} ${n(p.y)}`).join(' ')} Z`;
    }
    return corePath(diamondCore(box, r), r);
}

// The SVG `d` for an outline — the shape outlineHits intersects, drawn.
export function outlinePath(shape: OutlineShape): string {
    if (shape.kind === 'polygon') {
        if (shape.corners.length === 0) return '';
        return `${shape.corners.map((p, i) => `${i === 0 ? 'M' : 'L'} ${n(p.x)} ${n(p.y)}`).join(' ')} Z`;
    }
    if (shape.kind === 'polyline') {
        if (shape.points.length === 0) return '';
        return shape.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${n(p.x)} ${n(p.y)}`).join(' ');
    }
    if (shape.kind === 'ellipse') {
        const { cx, cy, rx, ry } = shape;
        return `M ${n(cx - rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 0 1 ${n(cx + rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 0 1 ${n(cx - rx)} ${n(cy)} Z`;
    }
    return corePath(shape.core, shape.radius);
}

// core ⊕ disc(r) as a path: each core edge offset outward by r, joined by tangent arcs about the core
// vertices. A single-point core is the circle; a two-point core is the pill. roundedDiamondPath is this;
// roundedRectPath stays an independent builder so its exact-string tests keep this one honest.
function corePath(core: Point[], r: number): string {
    if (r <= 0 || core.length === 0) return '';
    if (core.length === 1) {
        const c = core[0];
        return `M ${n(c.x - r)} ${n(c.y)} A ${n(r)} ${n(r)} 0 0 1 ${n(c.x + r)} ${n(c.y)} A ${n(r)} ${n(r)} 0 0 1 ${n(c.x - r)} ${n(c.y)} Z`;
    }
    const parts: string[] = [];
    for (let i = 0; i < core.length; i++) {
        const v = core[i];
        const w = core[(i + 1) % core.length];
        const len = Math.hypot(w.x - v.x, w.y - v.y);
        if (len < EPS) continue;
        // The core winds clockwise in screen space (y down), so the outward normal of v→w is (dy, -dx).
        const nx = ((w.y - v.y) / len) * r;
        const ny = -((w.x - v.x) / len) * r;
        const start = { x: v.x + nx, y: v.y + ny };
        const end = { x: w.x + nx, y: w.y + ny };
        parts.push(i === 0 ? `M ${n(start.x)} ${n(start.y)}` : `A ${n(r)} ${n(r)} 0 0 1 ${n(start.x)} ${n(start.y)}`);
        parts.push(`L ${n(end.x)} ${n(end.y)}`);
    }
    if (parts.length === 0) return '';
    const first = parts[0].slice(2);
    parts.push(`A ${n(r)} ${n(r)} 0 0 1 ${first}`, 'Z');
    return parts.join(' ');
}

// --- primitives ---------------------------------------------------------------------------------

// Excalidraw's ellipseDistanceFromPoint (ported from elbow-heading, verbatim): three Newton-style
// iterations onto the ellipse quadrant, then the distance to the projected point.
function ellipseEdgeDistance(shape: { cx: number; cy: number; rx: number; ry: number }, p: Point): number {
    const a = shape.rx;
    const b = shape.ry;
    const tpx = p.x - shape.cx;
    const tpy = p.y - shape.cy;
    const px = Math.abs(tpx);
    const py = Math.abs(tpy);
    // The iteration divides by |q|, which is 0 at the exact centre (Excalidraw returns NaN there). The
    // nearest edge point from the centre is the semi-minor axis.
    if (px === 0 && py === 0) return Math.min(a, b);
    let tx = ELLIPSE_SEED;
    let ty = ELLIPSE_SEED;
    for (let i = 0; i < 3; i++) {
        const ex = ((a * a - b * b) * tx ** 3) / a;
        const ey = ((b * b - a * a) * ty ** 3) / b;
        const rx = a * tx - ex;
        const ry = b * ty - ey;
        const qx = px - ex;
        const qy = py - ey;
        const r = Math.hypot(ry, rx);
        const q = Math.hypot(qy, qx);
        tx = Math.min(1, Math.max(0, ((qx * r) / q + ex) / a));
        ty = Math.min(1, Math.max(0, ((qy * r) / q + ey) / b));
        const t = Math.hypot(ty, tx);
        tx /= t;
        ty /= t;
    }
    const mx = a * tx * Math.sign(tpx);
    const my = b * ty * Math.sign(tpy);
    return Math.hypot(tpx - mx, tpy - my);
}

function segEllipseHits(seg: Seg, cx: number, cy: number, rx: number, ry: number): Point[] {
    if (rx === 0 || ry === 0) return [];
    const dx = seg.b.x - seg.a.x;
    const dy = seg.b.y - seg.a.y;
    const fx = seg.a.x - cx;
    const fy = seg.a.y - cy;
    const A = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
    const B = 2 * ((fx * dx) / (rx * rx) + (fy * dy) / (ry * ry));
    const C = (fx * fx) / (rx * rx) + (fy * fy) / (ry * ry) - 1;
    const disc = B * B - 4 * A * C;
    if (A === 0 || disc < 0) return [];
    const sq = Math.sqrt(disc);
    const hits: Point[] = [];
    for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (t >= 0 && t <= 1) hits.push({ x: seg.a.x + t * dx, y: seg.a.y + t * dy });
    }
    return hits;
}

function segCircleHits(seg: Seg, c: Point, r: number): Point[] {
    const dx = seg.b.x - seg.a.x;
    const dy = seg.b.y - seg.a.y;
    const fx = seg.a.x - c.x;
    const fy = seg.a.y - c.y;
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * A * C;
    if (A === 0 || disc < 0) return [];
    const sq = Math.sqrt(disc);
    const hits: Point[] = [];
    for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (t >= 0 && t <= 1) hits.push({ x: seg.a.x + t * dx, y: seg.a.y + t * dy });
    }
    return hits;
}

function segSegIntersect(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
    const d1x = p2.x - p1.x;
    const d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x;
    const d2y = p4.y - p3.y;
    const denom = d1x * d2y - d1y * d2x;
    if (denom === 0) return null;
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
    const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

function distToSegment(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function dedupe(points: Point[]): Point[] {
    const out: Point[] = [];
    for (const p of points) {
        if (!out.some((q) => Math.abs(q.x - p.x) < EPS && Math.abs(q.y - p.y) < EPS)) out.push(p);
    }
    return out;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

function n(v: number): number {
    return Math.round(v * 1000) / 1000;
}
