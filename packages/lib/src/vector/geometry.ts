// Pure scene-space geometry for eigen|vector>. Angle is DEGREES at every boundary;
// radian math never escapes a function body. `Box` is the canonical transform core shared
// by hit-testing, bounds, the properties bar, and (later) the shared ObjectTransform
// primitive.

import { moveEndpoints, renormalize } from './elbow-pins';
import { elbowRoutingContext } from './elbow-route';
import { getLineHeightPx } from './font-metrics';
import {
    type Arrowhead,
    isBindable,
    isTransparent,
    parseBinding,
    serializeBinding,
    type VectorArrowElement,
    type VectorElement,
    type VectorLinearElement,
    type VectorShapeElement,
} from './types';

export type Point = { x: number; y: number };

// Canonical transform core: top-left origin + size + rotation. Structurally identical to
// the stored element fields, so hosts pass stored fields straight through.
export type Box = { x: number; y: number; width: number; height: number; angle: number };

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

const DEG_TO_RAD = Math.PI / 180;

// Canvas interaction steps shared by vector + slides, in scene/document units: arrow-key nudge
// (Shift = large) and the duplicate/paste cascade offset. One source so the two apps' keymaps match.
export const NUDGE_STEP = 1;
export const NUDGE_STEP_LARGE = 5;
export const DUPLICATE_OFFSET = 10;

export function boxCenter(box: Box): Point {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Rotate `point` around `center` by `angleDeg` (clockwise, y-down — matches SVG rotate()).
export function rotatePoint(point: Point, center: Point, angleDeg: number): Point {
    const rad = angleDeg * DEG_TO_RAD;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
        x: center.x + dx * cos - dy * sin,
        y: center.y + dx * sin + dy * cos,
    };
}

// Axis-aligned bounding box of a (possibly rotated) box — its four rotated corners.
export function getElementBounds(box: Box): Bounds {
    const corners: Point[] = [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height },
    ];
    const points = box.angle === 0 ? corners : corners.map((c) => rotatePoint(c, boxCenter(box), box.angle));
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// Marquee (rubber-band) selection semantics, shared by slides + vector. Drag direction
// picks the mode — the AutoCAD/Figma convention — with slides' dashed border (intersect) vs solid
// (contain) as the visual signal.
export type MarqueeMode = 'contain' | 'intersect';

// Rightward drag (current x ≥ start x) = 'contain'; leftward = 'intersect'. Resolve from the RAW
// start/current x, before the marquee rect is normalized to a min-corner box (that loses direction).
export function marqueeMode(startX: number, currentX: number): MarqueeMode {
    return currentX < startX ? 'intersect' : 'contain';
}

// Does an element (its axis-aligned bounds) fall in the marquee under `mode`? contain = fully inside;
// intersect = the boxes overlap at all. Pure AABB math — hosts map their element + marquee to Bounds.
export function marqueeHits(bounds: Bounds, marquee: Bounds, mode: MarqueeMode): boolean {
    if (mode === 'contain') {
        return (
            bounds.minX >= marquee.minX &&
            bounds.minY >= marquee.minY &&
            bounds.maxX <= marquee.maxX &&
            bounds.maxY <= marquee.maxY
        );
    }
    return (
        bounds.minX < marquee.maxX &&
        bounds.maxX > marquee.minX &&
        bounds.minY < marquee.maxY &&
        bounds.maxY > marquee.minY
    );
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
    };
}

// Union bounds of several boxes (multi-select). Caller guarantees a non-empty list.
export function getElementsBounds(boxes: Box[]): Bounds {
    return boxes.map(getElementBounds).reduce(unionBounds);
}

// Element bounds, arrow-aware: an arrow unions its rotated label rect into the box bounds, so a
// wide label on a short arrow is not clipped by the viewBox nor missed by marquee/ring. Every other
// element is exactly its box AABB. `arrowRoute` (the derived elbow polyline) replaces the stored box for an
// elbow arrow, whose bends spill outside the 2-endpoint box.
export function elementBounds(el: VectorElement, arrowRoute?: Point[]): Bounds {
    if (el.type !== 'arrow') return getElementBounds(el);
    const base = arrowRoute ? pointsBounds(arrowRoute.map((p) => linearLocalToScene(el, p))) : getElementBounds(el);
    const label = arrowLabelBox(el, arrowRoute);
    if (!label) return base;
    const hw = label.width / 2;
    const hh = label.height / 2;
    const corners: Point[] = [
        { x: label.center.x - hw, y: label.center.y - hh },
        { x: label.center.x + hw, y: label.center.y - hh },
        { x: label.center.x + hw, y: label.center.y + hh },
        { x: label.center.x - hw, y: label.center.y + hh },
    ].map((c) => linearLocalToScene(el, c));
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    return unionBounds(base, {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
    });
}

// Map a scene point into the box's unrotated local frame, so every hit-test works on an
// axis-aligned shape.
function toLocal(box: Box, point: Point): Point {
    return box.angle === 0 ? point : rotatePoint(point, boxCenter(box), -box.angle);
}

export function hitTestBox(box: Box, point: Point): boolean {
    const p = toLocal(box, point);
    return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
}

export function hitTestEllipse(box: Box, point: Point): boolean {
    const rx = box.width / 2;
    const ry = box.height / 2;
    if (rx === 0 || ry === 0) return false;
    const p = toLocal(box, point);
    const nx = (p.x - (box.x + rx)) / rx;
    const ny = (p.y - (box.y + ry)) / ry;
    return nx * nx + ny * ny <= 1;
}

export function hitTestDiamond(box: Box, point: Point): boolean {
    const rx = box.width / 2;
    const ry = box.height / 2;
    if (rx === 0 || ry === 0) return false;
    const p = toLocal(box, point);
    return Math.abs(p.x - (box.x + rx)) / rx + Math.abs(p.y - (box.y + ry)) / ry <= 1;
}

// --- Linear elements (freedraw / line) ------------------------------------------------
// points is a JSON `[[x,y],…]` string, scene units relative to (x,y); the bbox min corner is (0,0).
// Kept a string in the model so a whole stroke is one scalar write (never a per-sample Y.Array).

// The full stroke diameter is `strokeWidth * FREEDRAW_SIZE_FACTOR`; hit-testing widens a freedraw's
// tolerance by half of it (the visible ink half-width). The renderer feeds the same factor to
// perfect-freehand's `size`. One source, imported by scene-to-svg.
export const FREEDRAW_SIZE_FACTOR = 2.125;

// A path loops when its ends meet: ≥ 3 points and the first ≈ last within 8 scene units
// (Excalidraw's isPathALoop at zoom 1 — zoom-free so FE preview and BE export decide fill alike).
const CLOSE_PATH_THRESHOLD = 8;

// Excalidraw's getElementHitThreshold: a linear/arrow element is grabbed within the LARGER of the
// zoom-scaled screen threshold (0.85× — Excalidraw's tested floor; lower gets FP-flaky at high zoom)
// and half the drawn ink width plus 0.1. Replaces an additive threshold+ink that grew both together.
const LINEAR_HIT_SCREEN_FACTOR = 0.85;

// Hit tolerance in screen px (Excalidraw's DEFAULT_COLLISION_THRESHOLD); hosts divide by zoom so an
// element's grab radius is a constant on-screen distance at any zoom. One source so hover/hit-testing
// and the eraser can never drift apart.
export const HIT_THRESHOLD_SCREEN = 8;

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
    return JSON.stringify(points.map((p) => [round2(p.x), round2(p.y)]));
}

// Per-point pen pressure, the parallel array to a freedraw's points (Excalidraw's `pressures`). Any
// structural garbage or a non-finite/non-number entry ⇒ [] (the caller then falls back to simulate);
// finite values clamp to [0,1]. Kept a JSON string like points so a whole stroke is one scalar write.
export function parsePressures(pressures: string): number[] {
    let raw: unknown;
    try {
        raw = JSON.parse(pressures);
    } catch {
        return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: number[] = [];
    for (const p of raw) {
        if (typeof p !== 'number' || !Number.isFinite(p)) return [];
        out.push(Math.min(1, Math.max(0, p)));
    }
    return out;
}

export function serializePressures(pressures: number[]): string {
    return JSON.stringify(pressures.map((p) => round3(Math.min(1, Math.max(0, p)))));
}

// Re-derive (x, y, width, height, points) so the point bbox's MIN corner is the origin (every point
// non-negative) and width/height span the raw bbox — so the box ALWAYS equals the content and bounds,
// viewBox, selection ring, rotation pivot and hit-testing agree with no special case. `box` is the
// element's CURRENT box (its width/height only matter when rotated): the renderer rotates about the
// box centre, so translating the points by -min AND changing the extent both move that pivot; x/y
// shift so every point keeps its scene position (Excalidraw's _updatePoints centre correction).
export function normalizeLinear(
    box: Box,
    points: Point[],
): { x: number; y: number; width: number; height: number; points: string } {
    if (points.length === 0) return { x: box.x, y: box.y, width: 0, height: 0, points: '[]' };

    const b = pointsBounds(points);
    const width = b.maxX - b.minX;
    const height = b.maxY - b.minY;
    const shifted = points.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY }));
    const center = boxCenter(box);
    const d = rotatePoint(
        { x: b.minX + (width - box.width) / 2, y: b.minY + (height - box.height) / 2 },
        ORIGIN,
        box.angle,
    );
    return {
        x: center.x + d.x - width / 2,
        y: center.y + d.y - height / 2,
        width,
        height,
        points: serializePoints(shifted),
    };
}

// Scale points per axis to fit a new box (ObjectTransform resize). Scaling is about the origin (0,0),
// the bbox min corner, so non-negative points stay non-negative; a degenerate old dimension keeps that
// axis (nothing to scale from). resizeLinear re-normalizes after, so the invariant holds regardless.
export function rescalePoints(
    points: Point[],
    oldSize: { width: number; height: number },
    newSize: { width: number; height: number },
): Point[] {
    const sx = oldSize.width === 0 ? 1 : newSize.width / oldSize.width;
    const sy = oldSize.height === 0 ? 1 : newSize.height / oldSize.height;
    return points.map((p) => ({ x: p.x * sx, y: p.y * sy }));
}

// Every width/height write on a linear element goes through here: rescale the points to the new box
// per axis, then re-normalize so the bbox min corner stays the origin. The one owner of resize for the
// canvas onCommit, the panel's W/H inputs, and match-size.
export function resizeLinear(
    el: VectorLinearElement | VectorArrowElement,
    box: Box,
): { x: number; y: number; width: number; height: number; points: string } {
    return normalizeLinear(box, rescalePoints(parsePoints(el.points), el, box));
}

// Nearest distance from a point to a polyline (min over its segments). A single point degrades to the
// distance to that point; an empty path is unreachable.
export function distanceToPolyline(points: Point[], point: Point): number {
    if (points.length === 0) return Number.POSITIVE_INFINITY;
    if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y);
    let min = Number.POSITIVE_INFINITY;
    for (let i = 1; i < points.length; i++) {
        const d = distanceToSegment(point, points[i - 1], points[i]);
        if (d < min) min = d;
    }
    return min;
}

export function isClosedPath(points: Point[]): boolean {
    if (points.length < 3) return false;
    const first = points[0];
    const last = points[points.length - 1];
    return Math.hypot(first.x - last.x, first.y - last.y) <= CLOSE_PATH_THRESHOLD;
}

// `arrowRoute` is the derived elbow polyline (local frame); pass it for an elbow arrow so the hit-test runs
// against the routed segments, not the straight 2-point line. Ignored for every other element.
export function hitTestElement(element: VectorElement, point: Point, threshold: number, arrowRoute?: Point[]): boolean {
    switch (element.type) {
        case 'ellipse':
            return hitTestEllipse(element, point);
        case 'diamond':
            return hitTestDiamond(element, point);
        case 'rectangle':
        case 'text':
        case 'image':
            return hitTestBox(element, point);
        case 'freedraw':
        case 'line':
            return hitTestLinear(element, point, threshold);
        case 'arrow':
            return hitTestArrow(element, point, threshold, arrowRoute);
    }
}

// A linear element's local frame ↔ scene mapping. The renderer places every vertex at
// rotate(origin + local, boxCentre, angle), so hit-testing and the point-handles share this one
// transform — the pivot convention lives here, not copied at each call site.
export function linearSceneToLocal(box: Box, scene: Point): Point {
    const un = rotatePoint(scene, boxCenter(box), -box.angle);
    return { x: un.x - box.x, y: un.y - box.y };
}

export function linearLocalToScene(box: Box, local: Point): Point {
    return rotatePoint({ x: box.x + local.x, y: box.y + local.y }, boxCenter(box), box.angle);
}

// Unrotate the probe into the element's local frame, then measure to the polyline. Tolerance is the
// larger of the 0.85-scaled screen threshold and the drawn ink half-width (+0.1) per LINEAR_HIT_SCREEN_FACTOR;
// a closed, filled path is also hit anywhere inside.
function hitTestLinear(element: VectorLinearElement, point: Point, threshold: number): boolean {
    const points = parsePoints(element.points);
    if (points.length === 0) return false;
    const p = linearSceneToLocal(element, point);

    const inkHalf =
        element.type === 'freedraw' ? (element.strokeWidth * FREEDRAW_SIZE_FACTOR) / 2 : element.strokeWidth / 2;
    if (distanceToPolyline(points, p) <= Math.max(threshold * LINEAR_HIT_SCREEN_FACTOR, inkHalf + 0.1)) return true;
    return isClosedPath(points) && !isTransparent(element.backgroundColor) && pointInPolygon(p, points);
}

// An arrow is hit on its polyline (like a line) OR inside its label rect — both measured in the arrow's
// local frame (the label rotates with the arrow), so a wide label on a short arrow is still selectable.
// `route` is the derived elbow polyline; when given the hit runs against it instead of the stored points.
function hitTestArrow(el: VectorArrowElement, point: Point, threshold: number, route?: Point[]): boolean {
    const points = route ?? parsePoints(el.points);
    if (points.length === 0) return false;
    const p = linearSceneToLocal(el, point);
    if (distanceToPolyline(points, p) <= Math.max(threshold * LINEAR_HIT_SCREEN_FACTOR, el.strokeWidth / 2 + 0.1))
        return true;
    const label = arrowLabelBox(el, route);
    return (
        label !== null &&
        Math.abs(p.x - label.center.x) <= label.width / 2 &&
        Math.abs(p.y - label.center.y) <= label.height / 2
    );
}

// Point-to-segment distance (Excalidraw's distanceToLineSegment): project onto the segment, clamp the
// parameter to [0,1], measure to the clamped foot.
export function distanceToSegment(p: Point, a: Point, b: Point): number {
    const cx = b.x - a.x;
    const cy = b.y - a.y;
    const lenSq = cx * cx + cy * cy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * cx + (p.y - a.y) * cy) / lenSq));
    return Math.hypot(p.x - (a.x + t * cx), p.y - (a.y + t * cy));
}

// Even-odd ray cast, for inside-hits on a closed filled path.
function pointInPolygon(p: Point, points: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i];
        const b = points[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

function pointsBounds(points: Point[]): Bounds {
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

function round2(n: number): number {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
}

// Pressures are 0..1, so 2-decimal point rounding would flatten the width variation — keep 3 decimals.
function round3(n: number): number {
    const r = Math.round(n * 1000) / 1000;
    return r === 0 ? 0 : r;
}

// --- Arrows: bindings, endpoints, heads, labels ---------------------------------------
// Forward bindings only: an arrow endpoint stores a fixedPoint anchor as a proportion of the
// target shape's local w/h, so the anchor follows the shape's move/resize/rotate by construction. All
// scene units; degrees at the boundary. Straight arrows only — no elbow, no `mode`, orbit is the rule.

const BASE_BINDING_GAP = 5;
const BASE_BINDING_DISTANCE = 15; // = max(BASE_BINDING_GAP, 15), Excalidraw's floor
const BASE_ARROW_MIN_LENGTH = 10; // below this the bound endpoint snaps to the anchor, not the outline
// Excalidraw's normalizeFixedPoint bounds (binding.ts): a bind-time ratio is kept within ±10 of the box
// and never exactly 0.5. The half-dodge exists because a precise 0.5 makes the heading cone flip on
// floating-point noise; the ±10 bound just stops a shrunk shape flinging an anchor to infinity while
// still allowing the outline+gap dock to sit a little outside [0,1].
const FIXED_POINT_BOUND = 10;
const FIXED_POINT_EPSILON = 0.0001;
const ARROWHEAD_SIZE = 15;
const ARROWHEAD_SIZE_LONG = 25; // the plain 'arrow' head is longer
// Excalidraw shrinks a rectangle's projection diagonals by 15px at each end (getDiagonalsForBindableElement)
// — the focus points behave oddly right at the corners. Ellipse/diamond use un-shrunk centre lines.
const DIAGONAL_SHRINK = 15;
// A bind-time arrow this small (both extents < 3) is too degenerate to project a natural aim from — bind
// to the raw cursor instead (Excalidraw's projectFixedPointOntoDiagonal early-out).
const MIN_PROJECTABLE_ARROW = 3;

// The outward inflation of a shape's outline when snapping an endpoint to it, and the divide-by-zero
// floor for the anchor ratio: 5 + half the stroke, so a thicker border pushes the arrow out further.
export function bindingGap(shape: VectorShapeElement): number {
    return BASE_BINDING_GAP + shape.strokeWidth / 2;
}

// The proportional anchor for a scene point on a shape (bind time): unrotate the point into the shape's
// local frame, then take the ratio over max(size, gap) so a near-zero dimension can't divide to Infinity.
// Not clamped here — a point outside the shape yields a ratio outside [0,1]; anchorToScene clamps on use.
export function bindingAnchor(shape: VectorShapeElement, point: Point): [number, number] {
    const local = rotatePoint(point, boxCenter(shape), -shape.angle);
    const gap = bindingGap(shape);
    return [(local.x - shape.x) / Math.max(shape.width, gap), (local.y - shape.y) / Math.max(shape.height, gap)];
}

// Is a SCENE point inside a shape's exact fill (by type, unrotated about the centre) — the "focus point
// sits inside the box" test Excalidraw's projection uses to accept a diagonal hit (isPointInElement) and to
// suppress the side-midpoint snap when the cursor is buried inside (hitElementItself).
function pointInShape(shape: VectorShapeElement, point: Point): boolean {
    if (shape.type === 'ellipse') return hitTestEllipse(shape, point);
    if (shape.type === 'diamond') return hitTestDiamond(shape, point);
    return hitTestBox(shape, point);
}

// The four side midpoints of a shape in SCENE space, rotated by its angle: rect/ellipse → the right/bottom/
// left/top edge midpoints (an ellipse's are its axis extremes); diamond → the midpoints of its four slanted
// edges. Excalidraw's getSnapOutlineMidPoint order (right, bottom, left, top) so a bind-time midpoint snap
// resolves the same side on a tie. The one owner of this geometry — both the snap-to-midpoint bind and the
// snap-dot overlay read it, so the dots sit exactly where the dock lands.
export function shapeSideMidpoints(shape: VectorShapeElement): Point[] {
    const { x, y, width: w, height: h } = shape;
    const local: Point[] =
        shape.type === 'diamond'
            ? [
                  // The diamond's four VERTICES (its tips — getDiamondBaseCorners), where a bound arrow docks,
                  // NOT the slanted-edge midpoints. Same order as the rect sides: right, bottom, left, top.
                  { x: x + w, y: y + h / 2 }, // right tip
                  { x: x + w / 2, y: y + h }, // bottom tip
                  { x, y: y + h / 2 }, // left tip
                  { x: x + w / 2, y }, // top tip
              ]
            : [
                  { x: x + w, y: y + h / 2 }, // right
                  { x: x + w / 2, y: y + h }, // bottom
                  { x, y: y + h / 2 }, // left
                  { x: x + w / 2, y }, // top
              ];
    const center = boxCenter(shape);
    return local.map((p) => rotatePoint(p, center, shape.angle));
}

// The nearest focus SNAP target for a dragged aim — one of the shape's four side midpoints or its centre,
// within bindingDistance + strokeWidth/2, else null (eigen extension: Excalidraw's focus-point drag
// stores the RAW pointer ratio and lights no dots — arrows/focus.ts handleFocusPointDrag; Reinder wants the
// aim to snap to and light the shape's snap points, so this magnet mirrors SnapDots' side-midpoint set plus
// the centre). Scene coordinates throughout; the caller suppresses it on Ctrl/Cmd like every other snap.
export function focusSnapPoint(shape: VectorShapeElement, point: Point, zoom: number): Point | null {
    const within = bindingDistance(zoom) + shape.strokeWidth / 2;
    const targets = [...shapeSideMidpoints(shape), boxCenter(shape)];
    let best: Point | null = null;
    let bestDist = within;
    for (const t of targets) {
        const d = Math.hypot(point.x - t.x, point.y - t.y);
        if (d <= bestDist) {
            bestDist = d;
            best = t;
        }
    }
    return best;
}

// The nearest side midpoint the bind-time snap docks onto, or null: the FIRST midpoint within
// bindingDistance + strokeWidth/2 of `point`, and only when the cursor sits OUTSIDE the shape's fill
// (Excalidraw's getSnapOutlineMidPoint — buried-inside cursors fall through to the diagonal projection).
function snapOutlineMidPoint(shape: VectorShapeElement, point: Point, zoom: number): Point | null {
    if (pointInShape(shape, point)) return null;
    const within = bindingDistance(zoom) + shape.strokeWidth / 2;
    for (const mid of shapeSideMidpoints(shape)) {
        if (Math.hypot(point.x - mid.x, point.y - mid.y) <= within) return mid;
    }
    return null;
}

// Shrink a segment inward by `offset` at each end (along its own direction). A zero offset / degenerate
// segment is returned unchanged.
function shrinkSegment(a: Point, b: Point, offset: number): [Point, Point] {
    if (offset === 0) return [a, b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return [a, b];
    const ox = (dx / len) * offset;
    const oy = (dy / len) * offset;
    return [
        { x: a.x + ox, y: a.y + oy },
        { x: b.x - ox, y: b.y - oy },
    ];
}

// The two lines a straight arrow's bind-time aim projects onto (Excalidraw's getDiagonalsForBindableElement),
// in SCENE space rotated by the shape's angle: a rectangle uses its two corner diagonals (shrunk 15px at each
// end); an ellipse/diamond uses its vertical + horizontal centre lines (un-shrunk).
function shapeDiagonals(shape: VectorShapeElement): [[Point, Point], [Point, Point]] {
    const { x, y, width: w, height: h } = shape;
    const offset = shape.type === 'rectangle' ? DIAGONAL_SHRINK : 0;
    const [one, two]: [[Point, Point], [Point, Point]] =
        shape.type === 'rectangle'
            ? [
                  [
                      { x, y },
                      { x: x + w, y: y + h },
                  ],
                  [
                      { x: x + w, y },
                      { x, y: y + h },
                  ],
              ]
            : [
                  [
                      { x: x + w / 2, y },
                      { x: x + w / 2, y: y + h },
                  ],
                  [
                      { x, y: y + h / 2 },
                      { x: x + w, y: y + h / 2 },
                  ],
              ];
    const center = boxCenter(shape);
    const rot = (p: Point): Point => rotatePoint(p, center, shape.angle);
    const s1 = shrinkSegment(one[0], one[1], offset);
    const s2 = shrinkSegment(two[0], two[1], offset);
    return [
        [rot(s1[0]), rot(s1[1])],
        [rot(s2[0]), rot(s2[1])],
    ];
}

// Project a straight arrow's bind-time aim onto a natural line of the shape (Excalidraw's
// projectFixedPointOntoDiagonal), so a fresh bind aims THROUGH the shape rather than at the raw cursor.
// Returns a SCENE point, or null to fall back to the raw cursor. In order: a snap to a side midpoint the
// cursor is near (outside the shape); else the crossing of the ray `otherEnd → point` (extended) with the
// shape's diagonals/centre lines, nearest to `otherEnd`, accepted only when it lands inside the shape.
// `otherEnd` is the arrow's opposite aim (the other endpoint, or its anchor when that end is bound) — the
// point that stays put while this endpoint drags. Applied at BIND time only (creation + endpoint-drag);
// dragging the focus dot stores the raw aim, never re-projected (handleFocusPointDrag). Elbow arrows never
// call this — their dock is resolved from the outline, not a diagonal.
export function projectFixedPointOntoDiagonal(
    shape: VectorShapeElement,
    point: Point,
    otherEnd: Point,
    arrowSize: { width: number; height: number },
    zoom: number,
): Point | null {
    if (arrowSize.width < MIN_PROJECTABLE_ARROW && arrowSize.height < MIN_PROJECTABLE_ARROW) return null;
    const mid = snapOutlineMidPoint(shape, point, zoom);
    if (mid) return mid;
    const [diag1, diag2] = shapeDiagonals(shape);
    const a = otherEnd;
    // A point far along a → point (past `point`), long enough for the ray to cross both diagonals: their
    // combined reach is 2·|a→point| + the longer diagonal, so segSegIntersect always catches the crossing.
    const reach =
        2 * Math.hypot(point.x - a.x, point.y - a.y) +
        Math.max(
            Math.hypot(diag1[1].x - diag1[0].x, diag1[1].y - diag1[0].y),
            Math.hypot(diag2[1].x - diag2[0].x, diag2[1].y - diag2[0].y),
        );
    const b = { x: a.x + (point.x - a.x) * reach, y: a.y + (point.y - a.y) * reach };
    const p1 = segSegIntersect(a, b, diag1[0], diag1[1]);
    const p2 = segSegIntersect(a, b, diag2[0], diag2[1]);
    const d1 = p1 ? Math.hypot(p1.x - a.x, p1.y - a.y) : null;
    const d2 = p2 ? Math.hypot(p2.x - a.x, p2.y - a.y) : null;
    let projection: Point | null;
    if (d1 !== null && d2 !== null) projection = d1 < d2 ? p1 : p2;
    else projection = p1 ?? p2 ?? null;
    return projection && pointInShape(shape, projection) ? projection : null;
}

// The scene point a STRAIGHT arrow's anchor resolves to on the CURRENT shape: the ratio of its w/h, rotated
// by its angle. The ratio is clamped to [0,1] here (clampUnit) so a shrunk shape can't fling a straight
// arrow's chord anchor off the box. An elbow end reads through elbowAnchorScene instead — its stored
// fixedPoint is the outline+gap dock, deliberately a little outside [0,1], so it must NOT be unit-clamped.
export function anchorToScene(shape: VectorShapeElement, fixedPoint: [number, number]): Point {
    const [fx, fy] = clampUnit(fixedPoint);
    return rotatePoint(
        { x: shape.x + shape.width * fx, y: shape.y + shape.height * fy },
        boxCenter(shape),
        shape.angle,
    );
}

function clampUnit([fx, fy]: [number, number]): [number, number] {
    return [clamp(fx, 0, 1), clamp(fy, 0, 1)];
}

// Excalidraw's normalizeFixedPoint (binding.ts:2716): keep a bind-time ratio within ±10 of the box and never
// exactly 0.5 (a precise 0.5 makes the heading cone flip on FP noise). Shared by both binds' write
// path (elbow: elbowBindPoint; straight: the diagonal-projection upgrade) and by the elbow read
// (elbowAnchorScene), so preview → fixedPoint → rest-endpoint is one function composition in both directions.
export function normalizeFixedPoint([fx, fy]: [number, number]): [number, number] {
    const cx = clamp(fx, -FIXED_POINT_BOUND, FIXED_POINT_BOUND);
    const cy = clamp(fy, -FIXED_POINT_BOUND, FIXED_POINT_BOUND);
    if (Math.abs(cx - 0.5) < FIXED_POINT_EPSILON || Math.abs(cy - 0.5) < FIXED_POINT_EPSILON) {
        return [dodgeHalf(cx), dodgeHalf(cy)];
    }
    return [cx, cy];
}

function dodgeHalf(ratio: number): number {
    return Math.abs(ratio - 0.5) < FIXED_POINT_EPSILON ? 0.5001 : ratio;
}

// The scene point an ELBOW end rests at: the fixedPoint mapped straight onto the current box (no chord — the
// other end never enters), bounded exactly as Excalidraw's getGlobalFixedPointForBindableElement. The stored
// fixedPoint already encodes the outline+gap dock (elbowBindPoint), so this sits the endpoint on the
// anchor's own side and holds it there no matter where the other end moves.
export function elbowAnchorScene(shape: VectorShapeElement, fixedPoint: [number, number]): Point {
    const [fx, fy] = normalizeFixedPoint(fixedPoint);
    return rotatePoint(
        { x: shape.x + shape.width * fx, y: shape.y + shape.height * fy },
        boxCenter(shape),
        shape.angle,
    );
}

// Where the segment from → anchor crosses the shape's outline inflated by `gap`, nearest to `from`; the
// anchor itself when it never crosses. Everything happens in the shape's unrotated local
// frame (rect: sharp inflated sides even for round rects — accepted drift; diamond: inflated edges;
// ellipse: radii + gap), then the hit rotates back by the shape's angle.
export function outlinePoint(shape: VectorShapeElement, from: Point, anchor: Point, gap: number): Point {
    const center = boxCenter(shape);
    const a = rotatePoint(from, center, -shape.angle);
    const b = rotatePoint(anchor, center, -shape.angle);
    // Extend past the anchor so a far endpoint still reaches the inflated outline.
    const far = extendPast(a, b, Math.max(shape.width, shape.height) + 2 * gap);
    const hits = outlineHits(shape, a, far, gap);
    if (hits.length === 0) return anchor;
    let best = hits[0];
    let bestDist = distSq(a, best);
    for (const h of hits) {
        const d = distSq(a, h);
        if (d < bestDist) {
            bestDist = d;
            best = h;
        }
    }
    return rotatePoint(best, center, shape.angle);
}

// All intersections of the SCENE segment a→b with `shape`'s outline inflated outward by `gap`, in scene
// space (outlineHits works in the shape's unrotated local frame; this rotates in and back out). One source
// for the outline geometry the elbow dock (elbowBindPoint) and outlinePoint both consume.
export function outlineIntersections(shape: VectorShapeElement, a: Point, b: Point, gap: number): Point[] {
    const center = boxCenter(shape);
    const la = rotatePoint(a, center, -shape.angle);
    const lb = rotatePoint(b, center, -shape.angle);
    return outlineHits(shape, la, lb, gap).map((h) => rotatePoint(h, center, shape.angle));
}

export type CubicBezier = [Point, Point, Point, Point];

// The arrow curve's parametric form — the ONE geometry-side owner of the shape roughjs's `gen.curve`
// draws for a round (non-elbow) arrow. Golden-locked by test to roughjs's `_curve` control points at
// roughness 0: a uniform Catmull-Rom cardinal spline (curveTightness 0 ⇒ s = 1) with the first and last
// points duplicated so the shaft passes through its endpoints. `points` must have ≥ 2 entries.
export function arrowCurveBeziers(points: Point[]): CubicBezier[] {
    const ps = [points[0], points[0], ...points.slice(1), points[points.length - 1]];
    const beziers: CubicBezier[] = [];
    for (let i = 1; i + 2 < ps.length; i++) {
        const p0 = ps[i - 1];
        const p1 = ps[i];
        const p2 = ps[i + 1];
        const p3 = ps[i + 2];
        beziers.push([
            p1,
            { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
            { x: p2.x + (p1.x - p3.x) / 6, y: p2.y + (p1.y - p3.y) / 6 },
            p2,
        ]);
    }
    return beziers;
}

function cubicAt(bez: CubicBezier, t: number): Point {
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    return {
        x: a * bez[0].x + b * bez[1].x + c * bez[2].x + d * bez[3].x,
        y: a * bez[0].y + b * bez[1].y + c * bez[2].y + d * bez[3].y,
    };
}

// Polyline approximation of the arrow curve (`samplesPerSegment` points per bezier), through the first and
// last vertex. Used by the golden lock test and the curved bound-endpoint dock.
export function sampleArrowCurve(points: Point[], samplesPerSegment: number): Point[] {
    if (points.length < 2) return points.map((p) => ({ ...p }));
    const beziers = arrowCurveBeziers(points);
    const out: Point[] = [beziers[0][0]];
    for (const bez of beziers) {
        for (let s = 1; s <= samplesPerSegment; s++) out.push(cubicAt(bez, s / samplesPerSegment));
    }
    return out;
}

// Sample count per terminal bezier when docking a curved arrow's bound end onto the outline.
const CURVE_DOCK_SAMPLES = 24;

// Where the CURVED shaft first crosses the shape's inflated outline, walking the terminal span from the
// arrow body toward the bound end. Endpoint-independent: the bound end is replaced by `anchor` (the point
// the fixedPoint resolves to, inside the shape), so the dock depends only on the interior vertices, the
// anchor and the shape — never on the stored endpoint. That makes it a strict fixed point under
// followBindings (a settled arrow re-solves to the identical crossing). null when the curve never crosses
// (buried inside / out of reach) → the caller keeps the straight-chord result.
function curveOutlineDock(
    arrow: VectorArrowElement,
    end: 'start' | 'end',
    shape: VectorShapeElement,
    points: Point[],
    anchor: Point,
    gap: number,
): Point | null {
    const scene = points.map((p) => linearLocalToScene(arrow, p));
    scene[end === 'start' ? 0 : scene.length - 1] = anchor;
    // Orient so index 0 is the arrow body and the last index is the bound end (curve is reversal-symmetric).
    const oriented = end === 'start' ? scene.slice().reverse() : scene;
    const beziers = arrowCurveBeziers(oriented);
    const span = beziers.slice(Math.max(0, beziers.length - 2));
    let prev: Point | null = null;
    for (const bez of span) {
        for (let s = 0; s <= CURVE_DOCK_SAMPLES; s++) {
            const pt = cubicAt(bez, s / CURVE_DOCK_SAMPLES);
            if (prev) {
                const hits = outlineIntersections(shape, prev, pt, gap);
                let best: Point | null = null;
                let bestDist = Number.POSITIVE_INFINITY;
                for (const h of hits) {
                    const d = distSq(prev, h);
                    if (d < bestDist) {
                        bestDist = d;
                        best = h;
                    }
                }
                if (best) return best;
            }
            prev = pt;
        }
    }
    return null;
}

// A bound endpoint's scene position: snap the anchor to the shape outline along the segment from the
// adjacent vertex, with Excalidraw's guard — if that would make the arrow shorter than 10 units, sit on the
// anchor instead (a degenerate arrow would otherwise flip inside the shape). A curved (round, ≥3-point)
// arrow docks on the CURVE∩outline crossing instead of the straight chord, so the drawn shaft meets the
// outline exactly at the head; a strict fixed point at stored precision keeps a settled arrow from redirtying.
export function boundEndpoint(arrow: VectorArrowElement, end: 'start' | 'end', shape: VectorShapeElement): Point {
    const points = parsePoints(arrow.points);
    if (points.length < 2) return linearLocalToScene(arrow, points[0] ?? ORIGIN);
    const thisLocal = end === 'start' ? points[0] : points[points.length - 1];
    const binding = parseBinding(end === 'start' ? arrow.startBinding : arrow.endBinding);
    if (!binding) return linearLocalToScene(arrow, thisLocal);
    // An elbow end resolves from the fixedPoint alone — the dock on its own side, no chord, the other
    // end never enters — so it can't change side when the other end moves. Straight ends keep the chord
    // orbit below (that IS Excalidraw parity, and the anchor UX is layered around it).
    if (arrow.elbow) return elbowAnchorScene(shape, binding.fixedPoint);
    // Excalidraw aims the chord from the ADJACENT vertex (updateBoundPoint, index 1 / -2), so a dragged
    // mid point slides the attachment along the outline to face it. Same point as the far end for 2-point
    // arrows.
    const otherScene = linearLocalToScene(arrow, end === 'start' ? points[1] : points[points.length - 2]);
    const anchor = anchorToScene(shape, binding.fixedPoint);
    const gap = bindingGap(shape);
    let endpoint = outlinePoint(shape, otherScene, anchor, gap);
    if (arrow.roundness === 'round' && points.length >= 3) {
        const dock = curveOutlineDock(arrow, end, shape, points, anchor, gap);
        if (dock) {
            // Strict fixed point: if the dock rounds to the already-stored endpoint (stored precision =
            // serializePoints' round2), return the exact stored point so followBindings sees no change.
            const dockLocal = linearSceneToLocal(arrow, dock);
            endpoint =
                round2(dockLocal.x) === thisLocal.x && round2(dockLocal.y) === thisLocal.y
                    ? linearLocalToScene(arrow, thisLocal)
                    : dock;
        }
    }
    if (Math.hypot(endpoint.x - otherScene.x, endpoint.y - otherScene.y) <= BASE_ARROW_MIN_LENGTH) return anchor;
    return endpoint;
}

// Recompute both bound endpoints from the CURRENT shapes and re-normalize; null when nothing
// changed (the caller then skips the write). Each new scene endpoint converts into the arrow's local
// frame by unrotating about the arrow's OLD centre (linearSceneToLocal reads the current box), so a
// rotated arrow's untouched vertices hold their place — never recompute the centre from the new bbox
// first (that would be circular).
export function followBindings(
    arrow: VectorArrowElement,
    byId: Map<string, VectorElement>,
): { x: number; y: number; width: number; height: number; points: string; fixedSegments: string } | null {
    const start = boundShape(arrow.startBinding, byId);
    const end = boundShape(arrow.endBinding, byId);
    if (!start && !end) return null;
    const points = parsePoints(arrow.points);
    if (points.length < 2) return null;
    // PINNED: keep the interior polyline + pins verbatim, move only the bound endpoints and re-drop
    // their connector pairs (moveEndpoints), then renormalize as the sealed write. The A* router never runs.
    if (arrow.fixedSegments !== '') {
        const newStart = start ? boundEndpoint(arrow, 'start', start) : null;
        const newEnd = end ? boundEndpoint(arrow, 'end', end) : null;
        const moved = moveEndpoints(arrow, newStart, newEnd, elbowRoutingContext(arrow, byId));
        const patch = renormalize({ ...arrow, ...moved });
        if (
            patch.points === arrow.points &&
            patch.x === arrow.x &&
            patch.y === arrow.y &&
            patch.width === arrow.width &&
            patch.height === arrow.height &&
            patch.fixedSegments === arrow.fixedSegments
        ) {
            return null;
        }
        return patch;
    }

    // DERIVED: recompute the two endpoints and re-normalize (unchanged pre-pin behaviour).
    const next = points.map((p) => ({ ...p }));
    if (start) next[0] = linearSceneToLocal(arrow, boundEndpoint(arrow, 'start', start));
    if (end) next[next.length - 1] = linearSceneToLocal(arrow, boundEndpoint(arrow, 'end', end));
    const result = normalizeLinear(arrow, next);
    if (
        result.points === arrow.points &&
        result.x === arrow.x &&
        result.y === arrow.y &&
        result.width === arrow.width &&
        result.height === arrow.height
    ) {
        return null;
    }
    return { ...result, fixedSegments: '' };
}

export function boundShape(binding: string, byId: Map<string, VectorElement>): VectorShapeElement | null {
    const b = parseBinding(binding);
    if (!b) return null;
    const el = byId.get(b.elementId);
    return el && isBindable(el) ? el : null;
}

// How near (SCENE units) a dragged endpoint binds: 15 at zoom ≥ 1, growing to 30 when zoomed out so the
// reach stays a constant on-screen distance (Excalidraw's maxBindingDistance_simple).
export function bindingDistance(zoom: number): number {
    const z = zoom < 1 ? zoom : 1;
    return clamp(BASE_BINDING_DISTANCE / (z * 1.5), BASE_BINDING_DISTANCE, BASE_BINDING_DISTANCE * 2);
}

// Remap a binding's target through an old→new id map for duplicate/paste; a target outside the map (the
// bound shape wasn't in the copied set) clears the binding.
export function remapBinding(binding: string, idMap: Map<string, string>): string {
    const b = parseBinding(binding);
    if (!b) return '';
    const mapped = idMap.get(b.elementId);
    return mapped ? serializeBinding({ elementId: mapped, fixedPoint: b.fixedPoint }) : '';
}

export type ArrowheadGeometry =
    | { kind: 'barbs'; tip: Point; barb1: Point; barb2: Point }
    | { kind: 'circle'; center: Point; diameter: number };

// Head geometry in the arrow's local frame, from the raw last/first segment direction (we read the raw
// segment, not Excalidraw's roughjs bezier op — accepted drift). Sizes/angles are fixed constants; the head is
// capped at half its segment so a short arrow's head shrinks instead of overrunning it. 'barbs' feeds
// the arrow (two lines), bar (one line) and triangle (filled polygon); 'circle' a filled disc.
export function arrowheadGeometry(
    el: VectorArrowElement,
    points: Point[],
    position: 'start' | 'end',
    head: Arrowhead,
): ArrowheadGeometry | null {
    if (head === 'none' || points.length < 2) return null;
    const tip = position === 'end' ? points[points.length - 1] : points[0];
    const prev = position === 'end' ? points[points.length - 2] : points[1];
    const dx = tip.x - prev.x;
    const dy = tip.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const size = head === 'arrow' ? ARROWHEAD_SIZE_LONG : ARROWHEAD_SIZE;
    const minSize = Math.min(size, len * 0.5);
    const base = { x: tip.x - (dx / len) * minSize, y: tip.y - (dy / len) * minSize };
    // Floored at 1: a thin, short arrow's span + strokeWidth − 2 can go non-positive (no disc at all).
    if (head === 'circle') return { kind: 'circle', center: tip, diameter: Math.max(1, minSize + el.strokeWidth - 2) };
    const angle = head === 'bar' ? 90 : head === 'arrow' ? 20 : 25;
    return { kind: 'barbs', tip, barb1: rotatePoint(base, tip, -angle), barb2: rotatePoint(base, tip, angle) };
}

// The label's center (arrow local frame) and box: centered on the polyline's index-midpoint (odd → the
// middle vertex, even → the middle segment's midpoint), width client-measured (labelWidth),
// height = line count × the font's line height. null when the arrow has no label. Shared by hit-testing,
// bounds, and the renderer so the three agree. `route` overrides the stored points for an elbow arrow (its
// label rides the derived route's midpoint).
export function arrowLabelBox(
    el: VectorArrowElement,
    route?: Point[],
): { center: Point; width: number; height: number } | null {
    if (el.text === '') return null;
    const center = arrowLabelCenter(el, route);
    if (!center) return null;
    const lines = el.text.replace(/\r\n?/g, '\n').split('\n').length;
    return {
        center,
        width: el.labelWidth,
        height: lines * getLineHeightPx(el.fontFamily, el.fontSize),
    };
}

// The label anchor in the arrow's local frame: the polyline's index-midpoint (odd → the middle vertex,
// even → the middle segment's midpoint). null for a degenerate arrow (< 2 points). Text-free
// so the editor can center an empty label on the same anchor a committed one would render at. `route` (the
// derived elbow polyline) overrides the stored points when given.
export function arrowLabelCenter(el: VectorArrowElement, route?: Point[]): Point | null {
    const points = route ?? parsePoints(el.points);
    if (points.length < 2) return null;
    const n = points.length;
    if (n % 2 === 1) return points[(n - 1) / 2];
    const i = n / 2;
    return { x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2 };
}

// Intersections of the query segment a→b with a shape's outline inflated outward by `gap`, in the
// shape's unrotated local frame. Sharp corners throughout (accepted drift).
function outlineHits(shape: VectorShapeElement, a: Point, b: Point, gap: number): Point[] {
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    if (shape.type === 'ellipse') {
        return segEllipseHits(a, b, cx, cy, shape.width / 2 + gap, shape.height / 2 + gap);
    }
    const corners =
        shape.type === 'diamond'
            ? inflatedDiamondCorners(shape, gap)
            : [
                  { x: shape.x - gap, y: shape.y - gap },
                  { x: shape.x + shape.width + gap, y: shape.y - gap },
                  { x: shape.x + shape.width + gap, y: shape.y + shape.height + gap },
                  { x: shape.x - gap, y: shape.y + shape.height + gap },
              ];
    if (!corners) return [];
    const hits: Point[] = [];
    for (let i = 0; i < corners.length; i++) {
        const hit = segSegIntersect(a, b, corners[i], corners[(i + 1) % corners.length]);
        if (hit) hits.push(hit);
    }
    return hits;
}

// The four corners of a diamond whose edges are each pushed out by `gap` along their normal (parallel
// offset, sharp corners). Null for a degenerate (zero-extent) diamond — it can't meaningfully bind.
function inflatedDiamondCorners(shape: VectorShapeElement, gap: number): Point[] | null {
    const ax = shape.width / 2;
    const ay = shape.height / 2;
    if (ax === 0 || ay === 0) return null;
    const diag = Math.hypot(ax, ay);
    const aInf = ax + (gap * diag) / ay;
    const bInf = ay + (gap * diag) / ax;
    const cx = shape.x + ax;
    const cy = shape.y + ay;
    return [
        { x: cx, y: cy - bInf },
        { x: cx + aInf, y: cy },
        { x: cx, y: cy + bInf },
        { x: cx - aInf, y: cy },
    ];
}

// Segment ∩ segment, both bounded — the intersection point or null when parallel / not overlapping.
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

// Segment ∩ axis-aligned ellipse (center c, radii rx/ry): the real roots of the quadratic in the
// segment parameter that land within the segment.
function segEllipseHits(a: Point, b: Point, cx: number, cy: number, rx: number, ry: number): Point[] {
    if (rx === 0 || ry === 0) return [];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const fx = a.x - cx;
    const fy = a.y - cy;
    const A = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
    const B = 2 * ((fx * dx) / (rx * rx) + (fy * dy) / (ry * ry));
    const C = (fx * fx) / (rx * rx) + (fy * fy) / (ry * ry) - 1;
    const disc = B * B - 4 * A * C;
    if (A === 0 || disc < 0) return [];
    const sq = Math.sqrt(disc);
    const hits: Point[] = [];
    for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (t >= 0 && t <= 1) hits.push({ x: a.x + t * dx, y: a.y + t * dy });
    }
    return hits;
}

// Extend the ray a→b past b by `ext` scene units (a === b is left as-is).
function extendPast(a: Point, b: Point, ext: number): Point {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return b;
    return { x: b.x + (dx / len) * ext, y: b.y + (dy / len) * ext };
}

function distSq(a: Point, b: Point): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

// --- Resize / rotate transform math ---------------------------------------------------
// Ported verbatim from slides' app-local transform-geometry.ts (Rect{x,y,w,h} → canonical
// Box), with slides' module-level MIN_SIZE threaded as a `minSize` parameter so the same
// math serves a fixed-unit deck (slides passes 30) and a zoomable canvas (vector passes ~1).
// Angle is DEGREES throughout — no radian value escapes a function body (rotatePoint owns it).

const ORIGIN: Point = { x: 0, y: 0 };

// Resize an axis-aligned box by dragging one handle. The opposite corner/edge stays pinned
// (unless fromCenter). `mode` is a 'resize-<dir>' string. Angle is passed through unchanged
// — callers use resizeRotatedRect for rotated boxes.
export function applyResize(
    mode: string,
    dx: number,
    dy: number,
    { x: ox, y: oy, width: ow, height: oh, angle }: Box,
    { fromCenter, keepAspect }: { fromCenter: boolean; keepAspect: boolean },
    minSize: number,
): Box {
    // Strip the 'resize-' prefix first — 'resize' itself contains 'e' and 's', poisoning the substring check.
    const dir = mode?.split('-')[1] ?? '';
    const xDir = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
    const yDir = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
    // Aspect lock only applies to corners — on edges only one axis is intentional.
    const aspectLocked = keepAspect && xDir !== 0 && yDir !== 0 && ow > 0 && oh > 0;

    let dw = xDir * dx;
    let dh = yDir * dy;

    if (aspectLocked) {
        const aspect = ow / oh;
        if (Math.abs(dw / ow) >= Math.abs(dh / oh)) {
            dh = dw / aspect;
        } else {
            dw = dh * aspect;
        }
    }

    const sizeFactor = fromCenter ? 2 : 1;
    let w = ow + sizeFactor * dw;
    let h = oh + sizeFactor * dh;

    if (aspectLocked) {
        // Clamp both dimensions through a single scale so the ratio survives the minSize floor.
        const scale = Math.max(w / ow, minSize / ow, minSize / oh);
        w = ow * scale;
        h = oh * scale;
    } else {
        w = Math.max(minSize, w);
        h = Math.max(minSize, h);
    }

    let x: number;
    let y: number;
    if (fromCenter) {
        x = ox + (ow - w) / 2;
        y = oy + (oh - h) / 2;
    } else {
        x = xDir === -1 ? ox + ow - w : ox;
        y = yDir === -1 ? oy + oh - h : oy;
    }

    return { x, y, width: w, height: h, angle };
}

// Resize a rotated box: the dragged handle's opposite corner/edge stays fixed in world
// space and the box grows along its own (rotated) axes. Reuses applyResize in a
// center-origin local frame, then repositions the center so the pinned point holds. At
// angle 0 this returns exactly applyResize(...). Rotation is read from the box itself.
export function resizeRotatedRect(
    mode: string,
    dx: number,
    dy: number,
    start: Box,
    opts: { fromCenter: boolean; keepAspect: boolean },
    minSize: number,
): Box {
    const rotation = start.angle;
    if (!rotation) return applyResize(mode, dx, dy, start, opts, minSize);
    const cx = start.x + start.width / 2;
    const cy = start.y + start.height / 2;
    // Rotate the pointer delta into the box's unrotated frame (rotatePoint around ORIGIN is a
    // pure vector rotation — reused rather than a second helper).
    const local = rotatePoint({ x: dx, y: dy }, ORIGIN, -rotation);
    const r = applyResize(
        mode,
        local.x,
        local.y,
        { x: -start.width / 2, y: -start.height / 2, width: start.width, height: start.height, angle: 0 },
        opts,
        minSize,
    );
    const dCenter = rotatePoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, ORIGIN, rotation);
    return {
        x: cx + dCenter.x - r.width / 2,
        y: cy + dCenter.y - r.height / 2,
        width: r.width,
        height: r.height,
        angle: rotation,
    };
}

// Snap an angle (degrees) to the nearest `step` — used for Shift → 15° rotation.
export function snapAngle(deg: number, step = 15): number {
    return Math.round(deg / step) * step;
}

// Normalize degrees into [0, 360) for storage.
export function normalizeAngle(deg: number): number {
    return ((deg % 360) + 360) % 360;
}
