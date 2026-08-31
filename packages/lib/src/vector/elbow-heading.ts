// Heading + shape-geometry helpers for elbow routing, ported from Excalidraw's heading.ts + the
// binding/bounds seams the elbow router reaches into (packages/element/src/{heading,binding,bounds,distance}.ts).
// Kept separate from elbow-route.ts the way Excalidraw keeps heading.ts separate: this file answers
// "which side does the arrow leave a bound shape from, and where is its rest endpoint", the router answers
// "how does it snake there". Everything is SCENE space; shape angles are DEGREES (rotatePoint owns the
// radian conversion), matching the rest of packages/lib/src/vector.

import {
    bindingAnchor,
    bindingGap,
    boxCenter,
    distanceToSegment,
    elbowAnchorScene,
    getElementBounds,
    linearLocalToScene,
    normalizeFixedPoint,
    outlineIntersections,
    type Point,
    parsePoints,
    rotatePoint,
} from './geometry';
import {
    isBindable,
    parseBinding,
    serializeBinding,
    type VectorArrowElement,
    type VectorElement,
    type VectorShapeElement,
} from './types';

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

// Excalidraw's exact ellipse-projection iteration seed. The literal 0.707 (not Math.SQRT1_2) is the point —
// matching it byte-for-byte keeps ellipseDistance identical to the source; the more precise constant drifts
// the result. Hoisted to one place so the biome allowance lives once, not once per `let`.
// biome-ignore lint/suspicious/noApproximativeNumericConstant: parity with Excalidraw's 0.707 seed
const ELLIPSE_SEED = 0.707;

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

// --- elbow bind-time dock (Excalidraw's bindPointToSnapToElementOutline elbow branch + snapToMid +
// avoidRectangularCorner) --------------------------------------------------------------------------------
// D2: an elbow end's fixedPoint is stored from the DOCK — the point on the shape's outline+gap the endpoint
// snaps to — not from the raw cursor, so the preview the user releases on is exactly what commits. EP-U3's
// bindingFor calls elbowBindPoint per drag frame (dock = the previewed endpoint) and again on commit
// (fixedPoint = the stored anchor); boundEndpoint then reproduces the same dock at rest via elbowAnchorScene.

// Below this w/h a shape has no interior to anchor a proportional point into — bind to the (0.5-dodged)
// centre so the arrow stays put on a later resize. Excalidraw's MIN_BINDABLE_SIZE.
const MIN_BINDABLE_SIZE = 1;
// The elbow base gap, used only for the axis-swap intersection fallback (Excalidraw's BASE_BINDING_GAP_ELBOW).
const BASE_BINDING_GAP_ELBOW = 5;
// Excalidraw's PRECISION: an intersection this close to the edge point is treated as no snap.
const DOCK_PRECISION = 1e-4;

// Where a raw scene point docks onto a bindable shape for an elbow arrow, and the fixedPoint that stores it.
// `dock` is the outline+gap point (the previewed/rest endpoint); `fixedPoint` is its ratio through
// normalizeFixedPoint, so it can sit a little outside [0,1] and never exactly 0.5.
export function elbowBindPoint(shape: VectorShapeElement, point: Point): { dock: Point; fixedPoint: [number, number] } {
    if (shape.width < MIN_BINDABLE_SIZE || shape.height < MIN_BINDABLE_SIZE) {
        const fixedPoint = normalizeFixedPoint([0.5, 0.5]);
        return { dock: elbowAnchorScene(shape, fixedPoint), fixedPoint };
    }
    const dock = elbowDock(shape, point);
    return { dock, fixedPoint: normalizeFixedPoint(bindingAnchor(shape, dock)) };
}

// When an arrow with shape bindings gains the elbow flag (the panel's to-elbow switch), each bound end's
// fixedPoint was stored for the STRAIGHT read — bindingAnchor's raw ratio, which anchorToScene chord-orbits
// onto the outline. The elbow read (elbowAnchorScene) maps that ratio straight onto the box with no chord, so
// it would rest the endpoint INSIDE the shape (the create-then-toggle drift). Re-dock each bound end from its
// current scene endpoint through elbowBindPoint so the stored fixedPoint is the outline+gap dock; followBindings
// (run after the patch) then re-glues both ends on the elbow path.
export function redockBindingsForElbow(
    arrow: VectorArrowElement,
    byId: Map<string, VectorElement>,
): { startBinding: string; endBinding: string } {
    const points = parsePoints(arrow.points);
    const redock = (binding: string, endLocal: Point | undefined): string => {
        const b = parseBinding(binding);
        if (!b || !endLocal) return binding;
        const shape = byId.get(b.elementId);
        if (!shape || !isBindable(shape)) return binding;
        const scene = linearLocalToScene(arrow, endLocal);
        return serializeBinding({ elementId: b.elementId, fixedPoint: elbowBindPoint(shape, scene).fixedPoint });
    };
    return {
        startBinding: redock(arrow.startBinding, points[0]),
        endBinding: redock(arrow.endBinding, points[points.length - 1]),
    };
}

// The outline dock for a raw point: push it off a rectangle corner (avoidRectangularCorner), snap it toward
// the nearest side/vertex midpoint (snapToMid), then intersect the shape's outline+gap along the resolved
// axis. Falls back to the other axis with the elbow base gap, and to the edge point when neither crosses.
function elbowDock(shape: VectorShapeElement, point: Point): Point {
    const gap = bindingGap(shape);
    const center = boxCenter(shape);
    const aabb = aabbForElement(shape);
    const edgePoint = shape.type === 'rectangle' ? avoidRectangularCorner(shape, point, gap) : point;
    const isHorizontal = headingIsHorizontal(headingForPointFromElement(shape, aabb, point));
    const resolved = snapToMid(shape, edgePoint, 0.05, gap) ?? point;

    const intersection =
        dockIntersection(shape, center, resolved, isHorizontal, gap) ??
        dockIntersection(shape, center, resolved, !isHorizontal, BASE_BINDING_GAP_ELBOW);

    if (!intersection || distSq(edgePoint, intersection) < DOCK_PRECISION) return edgePoint;
    return intersection;
}

// One axis of the dock intersection: a ray from the shape centre (on the chosen axis line through `resolved`)
// outward through `resolved`, crossing the outline+gap. `isHorizontal` picks the ray's free axis exactly as
// Excalidraw does. Null when the ray is degenerate or misses.
function dockIntersection(
    shape: VectorShapeElement,
    center: Point,
    resolved: Point,
    isHorizontal: boolean,
    gap: number,
): Point | null {
    const otherPoint = isHorizontal ? { x: center.x, y: resolved.y } : { x: resolved.x, y: center.y };
    const dx = resolved.x - otherPoint.x;
    const dy = resolved.y - otherPoint.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const reach = Math.max(shape.width, shape.height) * 2;
    const far = { x: otherPoint.x + (dx / len) * reach, y: otherPoint.y + (dy / len) * reach };
    const hits = outlineIntersections(shape, otherPoint, far, gap);
    if (hits.length === 0) return null;
    // The ray leaves the interior and crosses one side; when it clips two, take the one nearest the resolved
    // dock direction (Excalidraw's degenerate distance sort collapses to the same single crossing here).
    let best = hits[0];
    let bestDist = distSq(resolved, best);
    for (const h of hits) {
        const d = distSq(resolved, h);
        if (d < bestDist) {
            bestDist = d;
            best = h;
        }
    }
    return best;
}

// Excalidraw's avoidRectangularCorner: when a point sits in one of the four diagonal corner regions of a
// rectangle, slide it onto the nearer adjacent edge (offset by the gap) so the dock never lands on the sharp
// corner. Everything in the shape's unrotated frame, rotated back out. Rectangles only.
function avoidRectangularCorner(shape: VectorShapeElement, p: Point, gap: number): Point {
    const center = boxCenter(shape);
    const np = rotatePoint(p, center, -shape.angle);
    const { x, y, width: w, height: h } = shape;
    const rot = (q: Point): Point => rotatePoint(q, center, shape.angle);
    if (np.x < x && np.y < y) {
        return np.y - y > -gap ? rot({ x: x - gap, y }) : rot({ x, y: y - gap });
    }
    if (np.x < x && np.y > y + h) {
        return np.x - x > -gap ? rot({ x, y: y + h + gap }) : rot({ x: x - gap, y: y + h });
    }
    if (np.x > x + w && np.y > y + h) {
        return np.x - x < w + gap ? rot({ x: x + w, y: y + h + gap }) : rot({ x: x + w + gap, y: y + h });
    }
    if (np.x > x + w && np.y < y) {
        return np.x - x < w + gap ? rot({ x: x + w, y: y - gap }) : rot({ x: x + w + gap, y });
    }
    return p;
}

// Excalidraw's snapToMid: within an adaptive band of a side (or a diamond vertex) the dock snaps to that
// side/vertex midpoint, so an endpoint dragged near the middle of an edge locks to it. The band is
// clamp(5%·size, 5, 80). The centre carries Excalidraw's −0.1 tie-break nudge. Null = no snap (caller keeps
// the raw point).
function snapToMid(shape: VectorShapeElement, p: Point, tolerance: number, gap: number): Point | null {
    const { x, y, width: w, height: h } = shape;
    const boxC = boxCenter(shape);
    const center = { x: boxC.x - 0.1, y: boxC.y - 0.1 };
    const np = rotatePoint(p, center, -shape.angle);
    const vThresh = clamp(tolerance * h, 5, 80);
    const hThresh = clamp(tolerance * w, 5, 80);
    const rot = (q: Point): Point => rotatePoint(q, center, shape.angle);
    // Too close to the centre makes the direction ambiguous.
    if (Math.hypot(center.x - np.x, center.y - np.y) < gap) return null;
    if (np.x <= x + w / 2 && np.y > center.y - vThresh && np.y < center.y + vThresh)
        return rot({ x: x - gap, y: center.y });
    if (np.y <= y + h / 2 && np.x > center.x - hThresh && np.x < center.x + hThresh)
        return rot({ x: center.x, y: y - gap });
    if (np.x >= x + w / 2 && np.y > center.y - vThresh && np.y < center.y + vThresh)
        return rot({ x: x + w + gap, y: center.y });
    if (np.y >= y + h / 2 && np.x > center.x - hThresh && np.x < center.x + hThresh)
        return rot({ x: center.x, y: y + h + gap });
    if (shape.type === 'diamond') {
        const thr = Math.max(hThresh, vThresh);
        const corners: Point[] = [
            { x: x + w / 4 - gap, y: y + h / 4 - gap },
            { x: x + (3 * w) / 4 + gap, y: y + h / 4 - gap },
            { x: x + w / 4 - gap, y: y + (3 * h) / 4 + gap },
            { x: x + (3 * w) / 4 + gap, y: y + (3 * h) / 4 + gap },
        ];
        for (const c of corners) if (Math.hypot(c.x - np.x, c.y - np.y) < thr) return rot(c);
    }
    return null;
}

function distSq(a: Point, b: Point): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}
