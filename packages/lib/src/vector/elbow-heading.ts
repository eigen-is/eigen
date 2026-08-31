// Heading + shape-geometry helpers for elbow routing, ported from Excalidraw's heading.ts + the
// binding/bounds seams the elbow router reaches into (packages/element/src/{heading,binding,bounds,distance}.ts).
// Kept separate from elbow-route.ts the way Excalidraw keeps heading.ts separate: this file answers
// "which side does the arrow leave a bound shape from, and where is its rest endpoint", the router answers
// "how does it snake there". Everything is SCENE space; shape angles are DEGREES (rotatePoint owns the
// radian conversion), matching the rest of packages/lib/src/vector.

import { boxCenter, getElementBounds, type Point, rotatePoint } from './geometry';
import type { VectorShapeElement } from './types';

// A unit orthogonal direction. Compared by value (compareHeading), never by reference.
export type Heading = { x: number; y: number };

export const HEADING_RIGHT: Heading = { x: 1, y: 0 };
export const HEADING_LEFT: Heading = { x: -1, y: 0 };
export const HEADING_DOWN: Heading = { x: 0, y: 1 };
export const HEADING_UP: Heading = { x: 0, y: -1 };

// A bounds tuple [minX, minY, maxX, maxY] — Excalidraw's Bounds shape. The router's dense box math (dynamic
// AABBs, grid) reads much closer to the source in tuple form; geometry's object Bounds is used at the seams.
export type B4 = [number, number, number, number];

// How near (SCENE units) a bound endpoint must sit to its shape for cone-based heading to apply. The router
// runs zoom-free (server + derive path), so this is maxBindingDistance_simple at zoom 1 = clamp(15/1.5,15,30).
export const MAX_BINDING_DISTANCE = 15;

// Excalidraw's vectorToHeading: snap a free vector to its dominant axis direction (the `<=` on LEFT and the
// strict `>` elsewhere are load-bearing — they decide the exit side on exact diagonals).
export function vectorToHeading(dx: number, dy: number): Heading {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (dx > ay) return HEADING_RIGHT;
    if (dx <= -ay) return HEADING_LEFT;
    if (dy > ax) return HEADING_DOWN;
    return HEADING_UP;
}

export function compareHeading(a: Heading, b: Heading): boolean {
    return a.x === b.x && a.y === b.y;
}

export function flipHeading(h: Heading): Heading {
    return { x: -h.x, y: -h.y };
}

export function headingIsHorizontal(h: Heading): boolean {
    return h.y === 0;
}

// The rotated-corner AABB of a shape (getElementBounds), optionally inflated per side. `offset` is
// Excalidraw's [top, right, down, left] tuple — note the asymmetric axis order, matching offsetFromHeading.
export function aabbForElement(shape: VectorShapeElement, offset?: B4): B4 {
    const b = getElementBounds(shape);
    if (!offset) return [b.minX, b.minY, b.maxX, b.maxY];
    const [top, right, down, left] = offset;
    return [b.minX - left, b.minY - top, b.maxX + right, b.maxY + down];
}

// The heading a bound endpoint leaves its shape by (Excalidraw's getHeadingForElbowArrowSnap): far from the
// shape it points from the shape centre to the endpoint; close to it, the search-cone / diamond-sector test
// picks the side. `origPoint` (the stored, pre-dock endpoint) gates the distance; `p` (the rest endpoint)
// and `aabb` drive the cone. An unbound end has no shape → it just points at the other endpoint.
export function getHeadingForElbowArrowSnap(
    p: Point,
    otherPoint: Point,
    shape: VectorShapeElement | null,
    aabb: B4 | null,
    origPoint: Point,
): Heading {
    const otherPointHeading = vectorToHeading(otherPoint.x - p.x, otherPoint.y - p.y);
    if (!shape || !aabb) return otherPointHeading;

    const d = distanceToElement(shape, origPoint);
    const distance = d > MAX_BINDING_DISTANCE ? null : d;
    if (!distance) {
        const c = boxCenter(shape);
        return vectorToHeading(p.x - c.x, p.y - c.y);
    }
    return headingForPointFromElement(shape, aabb, p);
}

// Euclidean distance from a scene point to a shape's outline (Excalidraw's distanceToElement). Sharp
// outlines throughout — the same accepted drift geometry.ts's outline snapping already takes for round
// rects — so the distance is measured against the rect/diamond edges, or the true ellipse curve.
export function distanceToElement(shape: VectorShapeElement, p: Point): number {
    const c = boxCenter(shape);
    const rp = rotatePoint(p, c, -shape.angle);
    if (shape.type === 'ellipse') return ellipseDistance(shape, c, rp);
    const corners = shape.type === 'diamond' ? diamondCorners(shape) : rectCorners(shape);
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < corners.length; i++) {
        min = Math.min(min, distanceToSegment(rp, corners[i], corners[(i + 1) % corners.length]));
    }
    return min;
}

function rectCorners(s: VectorShapeElement): Point[] {
    return [
        { x: s.x, y: s.y },
        { x: s.x + s.width, y: s.y },
        { x: s.x + s.width, y: s.y + s.height },
        { x: s.x, y: s.y + s.height },
    ];
}

function diamondCorners(s: VectorShapeElement): Point[] {
    return [
        { x: s.x + s.width / 2, y: s.y },
        { x: s.x + s.width, y: s.y + s.height / 2 },
        { x: s.x + s.width / 2, y: s.y + s.height },
        { x: s.x, y: s.y + s.height / 2 },
    ];
}

// Excalidraw's ellipseDistanceFromPoint: three Newton-style iterations onto the ellipse quadrant, then the
// distance to the projected point. `rp` is already unrotated into the shape's local frame.
function ellipseDistance(s: VectorShapeElement, center: Point, rp: Point): number {
    const a = s.width / 2;
    const b = s.height / 2;
    const tpx = rp.x - center.x;
    const tpy = rp.y - center.y;
    const px = Math.abs(tpx);
    const py = Math.abs(tpy);
    // The literal 0.707 (not Math.SQRT1_2) is Excalidraw's exact iteration seed — matching it byte-for-byte is
    // the point; the more precise constant would drift the result.
    // biome-ignore lint/suspicious/noApproximativeNumericConstant: parity with Excalidraw's 0.707 seed
    let tx = 0.707;
    // biome-ignore lint/suspicious/noApproximativeNumericConstant: parity with Excalidraw's 0.707 seed
    let ty = 0.707;
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

// Heading from the ×2 search cones around the shape's (inflated) AABB centre — a wide shape gets wider
// UP/DOWN cones. Diamonds use vertex sectors instead. Excalidraw's headingForPointFromElement.
function headingForPointFromElement(shape: VectorShapeElement, aabb: B4, p: Point): Heading {
    if (shape.type === 'diamond') return headingForPointFromDiamond(shape, aabb, p);
    const mid = centerOf(aabb);
    const topLeft = scaleFromOrigin({ x: aabb[0], y: aabb[1] }, mid, 2);
    const topRight = scaleFromOrigin({ x: aabb[2], y: aabb[1] }, mid, 2);
    const bottomLeft = scaleFromOrigin({ x: aabb[0], y: aabb[3] }, mid, 2);
    const bottomRight = scaleFromOrigin({ x: aabb[2], y: aabb[3] }, mid, 2);
    if (triangleIncludesPoint(topLeft, topRight, mid, p)) return HEADING_UP;
    if (triangleIncludesPoint(topRight, bottomRight, mid, p)) return HEADING_RIGHT;
    if (triangleIncludesPoint(bottomRight, bottomLeft, mid, p)) return HEADING_DOWN;
    return HEADING_LEFT;
}

// Diamond sectors: the four SHRINK-scaled, rotated vertices carve corner sectors (which win) and side
// sectors. Excalidraw's headingForPointFromDiamondElement.
function headingForPointFromDiamond(shape: VectorShapeElement, aabb: B4, p: Point): Heading {
    const mid = centerOf(aabb);
    const SHRINK = 0.95;
    const vertex = (vx: number, vy: number): Point => {
        const r = rotatePoint({ x: vx, y: vy }, mid, shape.angle);
        return { x: mid.x + (r.x - mid.x) * SHRINK, y: mid.y + (r.y - mid.y) * SHRINK };
    };
    const top = vertex(shape.x + shape.width / 2, shape.y);
    const right = vertex(shape.x + shape.width, shape.y + shape.height / 2);
    const bottom = vertex(shape.x + shape.width / 2, shape.y + shape.height);
    const left = vertex(shape.x, shape.y + shape.height / 2);
    const wide = shape.width > shape.height;

    // Corner sectors first.
    if (cross(sub(p, top), sub(top, right)) <= 0 && cross(sub(p, top), sub(top, left)) > 0) return dirTo(top, mid);
    if (cross(sub(p, right), sub(right, bottom)) <= 0 && cross(sub(p, right), sub(right, top)) > 0)
        return dirTo(right, mid);
    if (cross(sub(p, bottom), sub(bottom, left)) <= 0 && cross(sub(p, bottom), sub(bottom, right)) > 0)
        return dirTo(bottom, mid);
    if (cross(sub(p, left), sub(left, top)) <= 0 && cross(sub(p, left), sub(left, bottom)) > 0) return dirTo(left, mid);

    // Side sectors.
    if (cross(sub(p, mid), sub(top, mid)) <= 0 && cross(sub(p, mid), sub(right, mid)) > 0)
        return dirTo(wide ? top : right, mid);
    if (cross(sub(p, mid), sub(right, mid)) <= 0 && cross(sub(p, mid), sub(bottom, mid)) > 0)
        return dirTo(wide ? bottom : right, mid);
    if (cross(sub(p, mid), sub(bottom, mid)) <= 0 && cross(sub(p, mid), sub(left, mid)) > 0)
        return dirTo(wide ? bottom : left, mid);
    return dirTo(wide ? top : left, mid);
}

// --- small vector helpers (Excalidraw's @excalidraw/math, inlined) ---------------------

function centerOf(b: B4): Point {
    return { x: b[0] + (b[2] - b[0]) / 2, y: b[1] + (b[3] - b[1]) / 2 };
}

function scaleFromOrigin(p: Point, mid: Point, mult: number): Point {
    return { x: mid.x + (p.x - mid.x) * mult, y: mid.y + (p.y - mid.y) * mult };
}

function sub(a: Point, b: Point): Point {
    return { x: a.x - b.x, y: a.y - b.y };
}

function cross(a: Point, b: Point): number {
    return a.x * b.y - b.x * a.y;
}

function dirTo(from: Point, to: Point): Heading {
    return vectorToHeading(from.x - to.x, from.y - to.y);
}

// triangleIncludesPoint: FALSE for a point exactly on an edge (all-same-sign test).
function triangleIncludesPoint(a: Point, b: Point, c: Point, p: Point): boolean {
    const sign = (p1: Point, p2: Point, p3: Point) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = sign(p, a, b);
    const d2 = sign(p, b, c);
    const d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
    const cx = b.x - a.x;
    const cy = b.y - a.y;
    const lenSq = cx * cx + cy * cy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * cx + (p.y - a.y) * cy) / lenSq));
    return Math.hypot(p.x - (a.x + t * cx), p.y - (a.y + t * cy));
}
