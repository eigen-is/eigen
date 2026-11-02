// Geometry that asks the kind registry, and the arrow bindings built on it. An element's bounds and hit
// test dispatch to its kind. A bound arrow end stores a fixedPoint, a proportion of the target shape's
// width and height, so the end follows the shape when it moves, resizes or rotates. followBindings
// re-docks an arrow's ends on the shapes' current outlines, and the canvas runs it after every patch.

import type { PinPatch } from './elbow-pins';
import { moveEndpoints, renormalize } from './elbow-pins';
import { elbowRoutingContext } from './elbow-route';
import type { Bounds, Point } from './geometry';
import {
    arrowCurveBeziers,
    boxCenter,
    distance,
    linearLocalToScene,
    linearSceneToLocal,
    normalizeLinear,
    ORIGIN,
    rotatePoint,
} from './geometry';
import { ELEMENT_KINDS, isBindable } from './kinds';
import { bezierAt, clamp, nearestPoint, outlineHits, segSegIntersect } from './outline';
import { parsePoints, round } from './points';
import type { VectorArrowElement, VectorBindableElement, VectorElement } from './types';
import { parseBinding, serializeBinding } from './types';

// Element bounds, kind-aware: an arrow unions its rotated label rect into the box bounds; every other
// element is exactly its box AABB. `arrowRoute` (the derived elbow polyline) replaces the stored box for
// an elbow arrow, whose bends spill outside the 2-endpoint box.
export function elementBounds(el: VectorElement, arrowRoute?: Point[]): Bounds {
    return ELEMENT_KINDS[el.type].bounds(el, arrowRoute);
}

// `arrowRoute` is the derived elbow polyline (local frame); pass it for an elbow arrow so the hit-test runs
// against the routed segments, not the straight 2-point line. Ignored for every other element.
export function hitTestElement(element: VectorElement, point: Point, threshold: number, arrowRoute?: Point[]): boolean {
    return ELEMENT_KINDS[element.type].hitTest(element, point, threshold, arrowRoute);
}

const BASE_BINDING_GAP = 5;
const BASE_BINDING_DISTANCE = 15; // = max(BASE_BINDING_GAP, 15), Excalidraw's floor
const BASE_ARROW_MIN_LENGTH = 10; // below this the bound endpoint snaps to the anchor, not the outline
// Excalidraw's normalizeFixedPoint bounds: a bind-time ratio stays within ±10 of the box and is never
// exactly 0.5. A precise 0.5 makes the heading cone flip on floating-point noise. The ±10 bound stops a
// shrunk shape flinging an anchor to infinity, and still lets the outline+gap dock sit a little outside [0,1].
const FIXED_POINT_BOUND = 10;
const FIXED_POINT_EPSILON = 0.0001;
// A bind-time arrow this small (both extents < 3) is too degenerate to project a natural aim from — bind
// to the raw cursor instead (Excalidraw's projectFixedPointOntoDiagonal early-out).
const MIN_PROJECTABLE_ARROW = 3;

// The outward inflation of a shape's outline when snapping an endpoint to it, and the divide-by-zero
// floor for the anchor ratio: 5 + half the stroke, so a thicker border pushes the arrow out further.
export function bindingGap(shape: VectorBindableElement): number {
    return BASE_BINDING_GAP + shape.strokeWidth / 2;
}

// The proportional anchor for a scene point on a shape (bind time): unrotate the point into the shape's
// local frame, then take the ratio over max(size, gap) so a near-zero dimension can't divide to Infinity.
// Not clamped here — a point outside the shape yields a ratio outside [0,1]; anchorToScene clamps on use.
export function bindingAnchor(shape: VectorBindableElement, point: Point): [number, number] {
    const local = rotatePoint(point, boxCenter(shape), -shape.angle);
    const gap = bindingGap(shape);
    return [(local.x - shape.x) / Math.max(shape.width, gap), (local.y - shape.y) / Math.max(shape.height, gap)];
}

// Is a SCENE point inside a shape's exact fill (by type, unrotated about the center) — the "focus point
// sits inside the box" test Excalidraw's projection uses to accept a diagonal hit (isPointInElement) and to
// suppress the side-midpoint snap when the cursor is buried inside (hitElementItself).
function pointInShape(shape: VectorBindableElement, point: Point): boolean {
    return ELEMENT_KINDS[shape.type].hitTest(shape, point, 0);
}

// The four dock anchors of a shape in SCENE space, rotated by its angle — the registry's anchorPoints
// (rect/ellipse: the right/bottom/left/top edge midpoints; diamond: its four tips; pie: points on the
// slice). Excalidraw's getSnapOutlineMidPoint order, so a bind-time midpoint snap resolves the same side
// on a tie. The one owner of this geometry — both the snap-to-midpoint bind and the snap-dot overlay read
// it, so the dots sit exactly where the dock lands.
export function shapeAnchorPoints(shape: VectorBindableElement): Point[] {
    return ELEMENT_KINDS[shape.type].anchorPoints(shape);
}

// The nearest focus SNAP target for a dragged aim: one of the shape's four side midpoints or its center,
// within bindingDistance + strokeWidth/2, else null. Excalidraw stores the raw pointer ratio here. Eigen
// snaps the aim to the same points the snap dots show, plus the center, so the dot the user sees is where
// the aim lands. Scene coordinates throughout; the caller turns it off on Ctrl/Cmd like every other snap.
export function focusSnapPoint(shape: VectorBindableElement, point: Point, zoom: number): Point | null {
    const within = bindingDistance(zoom) + shape.strokeWidth / 2;
    const targets = [...shapeAnchorPoints(shape), boxCenter(shape)];
    let best: Point | null = null;
    let bestDist = within;
    for (const t of targets) {
        const d = distance(point, t);
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
function snapOutlineMidPoint(shape: VectorBindableElement, point: Point, zoom: number): Point | null {
    if (pointInShape(shape, point)) return null;
    const within = bindingDistance(zoom) + shape.strokeWidth / 2;
    for (const mid of shapeAnchorPoints(shape)) {
        if (distance(point, mid) <= within) return mid;
    }
    return null;
}

// Project a straight arrow's bind-time aim onto a natural line of the shape (Excalidraw's
// projectFixedPointOntoDiagonal), so a fresh bind aims THROUGH the shape rather than at the raw cursor.
// Returns a SCENE point, or null to fall back to the raw cursor. In order: a snap to a side midpoint the
// cursor is near (outside the shape); else the crossing of the ray `otherEnd → point` (extended) with the
// shape's diagonals/center lines, nearest to `otherEnd`, accepted only when it lands inside the shape.
// `otherEnd` is the arrow's opposite aim (the other endpoint, or its anchor when that end is bound) — the
// point that stays put while this endpoint drags. Applied at BIND time only (creation + endpoint-drag);
// dragging the focus dot stores the raw aim, never re-projected (handleFocusPointDrag). Elbow arrows never
// call this — their dock is resolved from the outline, not a diagonal.
export function projectFixedPointOntoDiagonal(
    shape: VectorBindableElement,
    point: Point,
    otherEnd: Point,
    arrowSize: { width: number; height: number },
    zoom: number,
): Point | null {
    if (arrowSize.width < MIN_PROJECTABLE_ARROW && arrowSize.height < MIN_PROJECTABLE_ARROW) return null;
    const mid = snapOutlineMidPoint(shape, point, zoom);
    if (mid) return mid;
    const [diag1, diag2] = ELEMENT_KINDS[shape.type].aimLines(shape);
    const a = otherEnd;
    // A point far along a → point (past `point`), long enough for the ray to cross both diagonals: their
    // combined reach is 2·|a→point| + the longer diagonal, so segSegIntersect always catches the crossing.
    const reach = 2 * distance(point, a) + Math.max(distance(diag1[1], diag1[0]), distance(diag2[1], diag2[0]));
    const b = { x: a.x + (point.x - a.x) * reach, y: a.y + (point.y - a.y) * reach };
    const p1 = segSegIntersect(a, b, diag1[0], diag1[1]);
    const p2 = segSegIntersect(a, b, diag2[0], diag2[1]);
    const d1 = p1 ? distance(p1, a) : null;
    const d2 = p2 ? distance(p2, a) : null;
    let projection: Point | null;
    if (d1 !== null && d2 !== null) projection = d1 < d2 ? p1 : p2;
    else projection = p1 ?? p2 ?? null;
    return projection && pointInShape(shape, projection) ? projection : null;
}

// The scene point a STRAIGHT arrow's anchor resolves to on the CURRENT shape: the ratio of its w/h, rotated
// by its angle. The ratio is clamped to [0,1] here (clampUnit) so a shrunk shape can't fling a straight
// arrow's chord anchor off the box. An elbow end reads through elbowAnchorScene instead — its stored
// fixedPoint is the outline+gap dock, deliberately a little outside [0,1], so it must NOT be unit-clamped.
export function anchorToScene(shape: VectorBindableElement, fixedPoint: [number, number]): Point {
    return ratioToScene(shape, clampUnit(fixedPoint));
}

// A [0,1]-ish ratio pair placed on the shape's current box and rotated with it.
function ratioToScene(shape: VectorBindableElement, [fx, fy]: [number, number]): Point {
    return rotatePoint(
        { x: shape.x + shape.width * fx, y: shape.y + shape.height * fy },
        boxCenter(shape),
        shape.angle,
    );
}

function clampUnit([fx, fy]: [number, number]): [number, number] {
    return [clamp(fx, 0, 1), clamp(fy, 0, 1)];
}

// Excalidraw's normalizeFixedPoint: keep a bind-time ratio within the bounds above. Both binds write
// through it (elbowBindPoint, and the straight arrow's diagonal projection), and the elbow read
// (elbowAnchorScene) goes through it too, so a preview, its stored fixedPoint and the rest endpoint agree.
export function normalizeFixedPoint([fx, fy]: [number, number]): [number, number] {
    const cx = clamp(fx, -FIXED_POINT_BOUND, FIXED_POINT_BOUND);
    const cy = clamp(fy, -FIXED_POINT_BOUND, FIXED_POINT_BOUND);
    return [dodgeHalf(cx), dodgeHalf(cy)];
}

function dodgeHalf(ratio: number): number {
    return Math.abs(ratio - 0.5) < FIXED_POINT_EPSILON ? 0.5001 : ratio;
}

// The scene point an ELBOW end rests at: the fixedPoint mapped straight onto the current box (no chord — the
// other end never enters), bounded exactly as Excalidraw's getGlobalFixedPointForBindableElement. The stored
// fixedPoint already encodes the outline+gap dock (elbowBindPoint), so this sits the endpoint on the
// anchor's own side and holds it there no matter where the other end moves.
export function elbowAnchorScene(shape: VectorBindableElement, fixedPoint: [number, number]): Point {
    return ratioToScene(shape, normalizeFixedPoint(fixedPoint));
}

// Where the segment from → anchor crosses the shape's outline inflated by `gap`, nearest to `from`; the
// anchor itself when it never crosses. Everything happens in the shape's unrotated local frame — the
// registry's outline, corner arcs and all — then the hit rotates back by the shape's angle.
export function outlinePoint(shape: VectorBindableElement, from: Point, anchor: Point, gap: number): Point {
    // Extend past the anchor so a far endpoint still reaches the inflated outline.
    const far = extendPast(from, anchor, Math.max(shape.width, shape.height) + 2 * gap);
    const hits = outlineIntersections(shape, from, far, gap);
    return hits.length === 0 ? anchor : nearestPoint(hits, from);
}

// All intersections of the SCENE segment a→b with `shape`'s outline inflated outward by `gap`, in scene
// space (shapeOutlineHits works in the shape's unrotated local frame; this rotates in and back out). One
// source for the outline geometry the elbow dock (elbowBindPoint) and outlinePoint both consume.
export function outlineIntersections(shape: VectorBindableElement, a: Point, b: Point, gap: number): Point[] {
    const center = boxCenter(shape);
    const la = rotatePoint(a, center, -shape.angle);
    const lb = rotatePoint(b, center, -shape.angle);
    return shapeOutlineHits(shape, la, lb, gap).map((h) => rotatePoint(h, center, shape.angle));
}

// Intersections of the query segment a→b with the shape's outline inflated outward by `gap`, in the
// shape's unrotated frame. The registry owns the outline, so what the renderer draws is what an arrow
// docks to.
function shapeOutlineHits(shape: VectorBindableElement, a: Point, b: Point, gap: number): Point[] {
    return outlineHits(ELEMENT_KINDS[shape.type].outline(shape, gap), a, b);
}

// Extend the ray a→b past b by `ext` scene units (a === b is left as-is).
function extendPast(a: Point, b: Point, ext: number): Point {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return b;
    return { x: b.x + (dx / len) * ext, y: b.y + (dy / len) * ext };
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
    shape: VectorBindableElement,
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
            const pt = bezierAt(bez, s / CURVE_DOCK_SAMPLES);
            if (prev) {
                const hits = outlineIntersections(shape, prev, pt, gap);
                if (hits.length > 0) return nearestPoint(hits, prev);
            }
            prev = pt;
        }
    }
    return null;
}

// The two scene points a bound end needs from the far side of the arrow: the point its chord AIMS from,
// and the point the degenerate guard MEASURES to. Both are the ADJACENT vertex (Excalidraw's
// updateBoundPoint, index 1 / -2), so dragging a mid vertex slides the attachment along the outline to
// face it. On a 2-point arrow that vertex IS the other end — and when THAT end is bound too it is being
// re-docked in the same pass, so aim from its anchor, the one point of it that holds still: both ends
// then land on the line through the two anchors, the rest state Excalidraw's per-frame
// updateBoundElements walks toward while a shape is dragged, reached here in one exact pass, so a settled
// arrow still re-solves to itself. The guard gets that end's own dock instead, because the two anchors
// stay tens of units apart while the docks cross past each other the moment the shapes touch.
function farSide(
    arrow: VectorArrowElement,
    end: 'start' | 'end',
    points: Point[],
    anchor: Point,
    byId: Map<string, VectorElement>,
): { aim: Point; dock: Point } {
    if (points.length === 2) {
        const otherBinding = end === 'start' ? arrow.endBinding : arrow.startBinding;
        const other = parseBinding(otherBinding);
        const otherShape = boundShape(otherBinding, byId);
        if (other && otherShape) {
            const otherAnchor = anchorToScene(otherShape, other.fixedPoint);
            return {
                aim: otherAnchor,
                dock: outlinePoint(otherShape, anchor, otherAnchor, bindingGap(otherShape)),
            };
        }
    }
    const adjacent = linearLocalToScene(arrow, points[end === 'start' ? 1 : points.length - 2]);
    return { aim: adjacent, dock: adjacent };
}

// A bound endpoint's scene position: snap the anchor to the shape outline along the segment from the
// chord aim above, with Excalidraw's guard — if that would leave less than 10 units between the two ends,
// sit on the anchor instead (a degenerate arrow would otherwise flip inside the shape). The guard is
// symmetric, so two shapes pushed together put BOTH ends on their anchors. A curved (round, ≥3-point)
// arrow docks on the CURVE∩outline crossing instead of the straight chord, so the drawn shaft meets the
// outline exactly at the head; a strict fixed point at stored precision keeps a settled arrow from redirtying.
export function boundEndpoint(
    arrow: VectorArrowElement,
    end: 'start' | 'end',
    shape: VectorBindableElement,
    byId: Map<string, VectorElement>,
): Point {
    const points = parsePoints(arrow.points);
    if (points.length < 2) return linearLocalToScene(arrow, points[0] ?? ORIGIN);
    const thisLocal = end === 'start' ? points[0] : points[points.length - 1];
    const binding = parseBinding(end === 'start' ? arrow.startBinding : arrow.endBinding);
    if (!binding) return linearLocalToScene(arrow, thisLocal);
    // An elbow end resolves from the fixedPoint alone — the dock on its own side, no chord, the other
    // end never enters — so it can't change side when the other end moves. Straight ends keep the chord
    // orbit below (that IS Excalidraw parity, and the anchor UX is layered around it).
    if (arrow.elbow) return elbowAnchorScene(shape, binding.fixedPoint);
    const anchor = anchorToScene(shape, binding.fixedPoint);
    const far = farSide(arrow, end, points, anchor, byId);
    const gap = bindingGap(shape);
    let endpoint = outlinePoint(shape, far.aim, anchor, gap);
    if (arrow.roundness === 'round' && points.length >= 3) {
        const dock = curveOutlineDock(arrow, end, shape, points, anchor, gap);
        if (dock) {
            // Strict fixed point: if the dock rounds to the already-stored endpoint (stored precision =
            // serializePoints' round2), return the exact stored point so followBindings sees no change.
            const dockLocal = linearSceneToLocal(arrow, dock);
            endpoint =
                round(dockLocal.x) === thisLocal.x && round(dockLocal.y) === thisLocal.y
                    ? linearLocalToScene(arrow, thisLocal)
                    : dock;
        }
    }
    if (distance(endpoint, far.dock) <= BASE_ARROW_MIN_LENGTH) return anchor;
    return endpoint;
}

// Recompute both bound endpoints from the CURRENT shapes and re-normalize; null when nothing
// changed (the caller then skips the write). Each new scene endpoint converts into the arrow's local
// frame by unrotating about the arrow's OLD center (linearSceneToLocal reads the current box), so a
// rotated arrow's untouched vertices hold their place — never recompute the center from the new bbox
// first (that would be circular).
export function followBindings(arrow: VectorArrowElement, byId: Map<string, VectorElement>): PinPatch | null {
    const start = boundShape(arrow.startBinding, byId);
    const end = boundShape(arrow.endBinding, byId);
    if (!start && !end) return null;
    const points = parsePoints(arrow.points);
    if (points.length < 2) return null;
    let patch: PinPatch;
    // PINNED: keep the interior polyline + pins verbatim, move only the bound endpoints and re-drop
    // their connector pairs (moveEndpoints), then renormalize as the sealed write. The A* router never runs.
    if (arrow.fixedSegments !== '') {
        const newStart = start ? boundEndpoint(arrow, 'start', start, byId) : null;
        const newEnd = end ? boundEndpoint(arrow, 'end', end, byId) : null;
        const moved = moveEndpoints(arrow, newStart, newEnd, elbowRoutingContext(arrow, byId));
        patch = renormalize({ ...arrow, ...moved });
    } else {
        // DERIVED: recompute the two endpoints and re-normalize. The docks round to stored precision here,
        // not only on serialization, and so does the box normalizeLinear derives from them. A box carrying a
        // digit the serialized points cannot would leave x/width drifting by 1e-14 under a settled arrow.
        const next = points.map((p) => ({ ...p }));
        if (start) next[0] = roundPoint(linearSceneToLocal(arrow, boundEndpoint(arrow, 'start', start, byId)));
        if (end) next[next.length - 1] = roundPoint(linearSceneToLocal(arrow, boundEndpoint(arrow, 'end', end, byId)));
        const norm = normalizeLinear(arrow, next);
        patch = {
            x: round(norm.x),
            y: round(norm.y),
            width: round(norm.width),
            height: round(norm.height),
            points: norm.points,
            fixedSegments: '',
        };
    }
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

export function boundShape(binding: string, byId: Map<string, VectorElement>): VectorBindableElement | null {
    const b = parseBinding(binding);
    if (!b) return null;
    const el = byId.get(b.elementId);
    return el && isBindable(el) ? el : null;
}

// How near (SCENE units) a dragged endpoint binds: 15 at zoom ≥ 1, growing to 30 when zoomed out so the
// reach stays a constant on-screen distance (Excalidraw's maxBindingDistance_simple).
export function bindingDistance(zoom: number): number {
    const z = Math.min(zoom, 1);
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

// A point at stored precision, the same quantization serializePoints applies on the way out.
function roundPoint(p: Point): Point {
    return { x: round(p.x), y: round(p.y) };
}
