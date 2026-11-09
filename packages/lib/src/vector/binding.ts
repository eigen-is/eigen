// The geometry that asks the kind registry: an element's bounds and hit test, which each kind answers for itself,
// and the arrow bindings built on them. A bound arrow end stores a fixedPoint, a fraction of the target shape's
// width and height, so the end follows the shape when it moves, resizes or rotates. followBindings docks an
// arrow's ends again on the shapes' current outlines, and the canvas runs it after every patch.

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

// An element's axis-aligned bounds, as its kind computes them. An arrow's include its turned label. Pass
// `arrowRoute`, the derived elbow polyline, for an elbow arrow, because its bends spill outside the box of its
// two endpoints.
export function elementBounds(el: VectorElement, arrowRoute?: Point[]): Bounds {
    return ELEMENT_KINDS[el.type].bounds(el, arrowRoute);
}

// Pass `arrowRoute`, the derived elbow polyline in the arrow's local frame, for an elbow arrow. The hit test then
// runs against the routed segments instead of the straight line between the endpoints.
export function hitTestElement(element: VectorElement, point: Point, threshold: number, arrowRoute?: Point[]): boolean {
    return ELEMENT_KINDS[element.type].hitTest(element, point, threshold, arrowRoute);
}

const BASE_BINDING_GAP = 5;
// Excalidraw's floor for how near an endpoint binds.
const BASE_BINDING_DISTANCE = 15;
// Below this length the bound endpoint sits on its anchor instead of the outline.
const BASE_ARROW_MIN_LENGTH = 10;
// Excalidraw's normalizeFixedPoint bounds. A bind-time ratio stays within 10 box sizes of the box, so a shrunk
// shape can't fling an anchor to infinity, while the dock past the outline may still sit a little outside [0, 1].
// A ratio is never exactly 0.5, because the heading cone would flip on floating-point noise there.
const FIXED_POINT_BOUND = 10;
const FIXED_POINT_EPSILON = 0.0001;
// An arrow under this size on both axes is too small to project an aim from, so it binds to the raw cursor.
// Excalidraw's projectFixedPointOntoDiagonal returns early the same way.
const MIN_PROJECTABLE_ARROW = 3;

// How far past a shape's outline a bound endpoint stops. It grows with the stroke, so a thicker border pushes
// the arrow out further. The anchor ratio also uses it as its smallest divisor.
export function bindingGap(shape: VectorBindableElement): number {
    return BASE_BINDING_GAP + shape.strokeWidth / 2;
}

// The anchor ratio of a scene point on a shape, taken at bind time in the shape's unturned frame. A side shorter
// than the gap divides by the gap, so a flat shape can't give an infinite ratio. A point outside the shape gives a
// ratio outside [0, 1], which anchorToScene clamps when it reads it.
export function bindingAnchor(shape: VectorBindableElement, point: Point): [number, number] {
    const local = rotatePoint(point, boxCenter(shape), -shape.angle);
    const gap = bindingGap(shape);
    return [(local.x - shape.x) / Math.max(shape.width, gap), (local.y - shape.y) / Math.max(shape.height, gap)];
}

// Whether a scene point lies inside the shape itself. The aim projection accepts a crossing only inside the
// shape, and skips the midpoint snap while the cursor is inside, as Excalidraw does.
function pointInShape(shape: VectorBindableElement, point: Point): boolean {
    return ELEMENT_KINDS[shape.type].hitTest(shape, point, 0);
}

// The four dock anchors of a shape in scene space, such as a rectangle's edge midpoints or a diamond's tips. The
// midpoint snap and the snap dots both read them, so a dot sits exactly where the dock lands.
export function shapeAnchorPoints(shape: VectorBindableElement): Point[] {
    return ELEMENT_KINDS[shape.type].anchorPoints(shape);
}

// The point a dragged aim snaps to: the nearest of the shape's dock anchors and its center, or null when none is
// within reach. Excalidraw keeps the raw pointer here. Eigen snaps to the points the dots show, so the aim lands
// on the dot the user sees. The caller turns the snap off on Ctrl or Cmd, as every other snap.
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

// The side midpoint a bind docks onto: the first one within reach of `point`, as in Excalidraw's
// getSnapOutlineMidPoint. A cursor inside the shape gets null and falls through to the projection.
function snapOutlineMidPoint(shape: VectorBindableElement, point: Point, zoom: number): Point | null {
    if (pointInShape(shape, point)) return null;
    const within = bindingDistance(zoom) + shape.strokeWidth / 2;
    for (const mid of shapeAnchorPoints(shape)) {
        if (distance(point, mid) <= within) return mid;
    }
    return null;
}

// Where a straight arrow aims when it binds, as Excalidraw's projectFixedPointOntoDiagonal does, so a new bind
// aims through the shape and not at the raw cursor. A cursor near a side midpoint snaps to it. Otherwise the ray
// from `otherEnd` through `point` crosses the shape's aim lines, and the crossing nearest `otherEnd` counts when it
// lies inside the shape. `otherEnd` is the point that holds still while this end drags: the other endpoint, or its
// anchor when that end is bound. Null means the raw cursor. Only a bind projects: a dragged focus dot keeps its raw
// aim, and an elbow arrow docks on the outline instead.
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
    // A point far enough along the ray that the segment crosses both aim lines wherever they lie.
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

// The scene point a straight arrow's anchor marks on the shape as it is now. The ratio is clamped to [0, 1], so a
// shrunk shape can't throw the anchor off its box. An elbow end reads through elbowAnchorScene instead, because
// its stored ratio is the dock past the outline, which sits a little outside [0, 1] on purpose.
export function anchorToScene(shape: VectorBindableElement, fixedPoint: [number, number]): Point {
    return ratioToScene(shape, clampUnit(fixedPoint));
}

// A ratio pair placed on the shape's current box and turned with it.
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

// Excalidraw's normalizeFixedPoint, which keeps a ratio within the bounds above. Every bind writes through it and
// the elbow read goes through it too, so a preview, its stored ratio and the endpoint at rest agree.
export function normalizeFixedPoint([fx, fy]: [number, number]): [number, number] {
    const cx = clamp(fx, -FIXED_POINT_BOUND, FIXED_POINT_BOUND);
    const cy = clamp(fy, -FIXED_POINT_BOUND, FIXED_POINT_BOUND);
    return [dodgeHalf(cx), dodgeHalf(cy)];
}

function dodgeHalf(ratio: number): number {
    return Math.abs(ratio - 0.5) < FIXED_POINT_EPSILON ? 0.5001 : ratio;
}

// The scene point an elbow end rests at: its stored ratio placed on the current box, bounded as Excalidraw's
// getGlobalFixedPointForBindableElement. The ratio already holds the dock past the outline, so the end stays on its
// own side wherever the other end moves.
export function elbowAnchorScene(shape: VectorBindableElement, fixedPoint: [number, number]): Point {
    return ratioToScene(shape, normalizeFixedPoint(fixedPoint));
}

// Where the line from `from` to the anchor crosses the shape's outline grown by `gap`, nearest to `from`. When it
// never crosses, the anchor itself.
function outlinePoint(shape: VectorBindableElement, from: Point, anchor: Point, gap: number): Point {
    // Extend past the anchor so a far endpoint still reaches the inflated outline.
    const far = extendPast(from, anchor, Math.max(shape.width, shape.height) + 2 * gap);
    const hits = outlineIntersections(shape, from, far, gap);
    return hits.length === 0 ? anchor : nearestPoint(hits, from);
}

// Every point where the scene segment from a to b crosses the shape's outline grown by `gap`. The outline is the
// kind's own, so an arrow docks on the edge the renderer draws. The crossing is found in the shape's unturned frame
// and turned back into the scene.
export function outlineIntersections(shape: VectorBindableElement, a: Point, b: Point, gap: number): Point[] {
    const center = boxCenter(shape);
    const la = rotatePoint(a, center, -shape.angle);
    const lb = rotatePoint(b, center, -shape.angle);
    return outlineHits(ELEMENT_KINDS[shape.type].outline(shape, gap), la, lb).map((hit) =>
        rotatePoint(hit, center, shape.angle),
    );
}

// The point `ext` scene units past b on the ray from a through b, or b when the two are the same point.
function extendPast(a: Point, b: Point, ext: number): Point {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return b;
    return { x: b.x + (dx / len) * ext, y: b.y + (dy / len) * ext };
}

// Sample count per terminal bezier when docking a curved arrow's bound end onto the outline.
const CURVE_DOCK_SAMPLES = 24;

// Where a curved shaft first crosses the shape's grown outline, walking its last span toward the bound end. The
// curve runs to the anchor instead of the stored endpoint, so the dock does not depend on where the end was. A
// settled arrow then docks again at the same crossing. Null when the curve never crosses, and the caller keeps the
// straight result.
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
    // The bound end goes last. The curve is the same in both directions.
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

// The two scene points a bound end needs from the other side of the arrow: where its line aims from, and what the
// short-arrow guard measures to. Both are the next vertex, as in Excalidraw's updateBoundPoint, so dragging a middle
// vertex slides the end along the outline to face it.
//
// On a two-point arrow the next vertex is the other end. When that end is bound too, it moves in the same pass, so
// the line aims from its anchor, which holds still. Both ends then land on the line through the two anchors in one
// pass, where Excalidraw gets there frame by frame. The guard measures to the other end's dock instead, because two
// anchors stay apart while the docks cross the moment the shapes touch.
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

// Where a bound end sits in the scene: on the shape's outline, along the line from its aim to its anchor. When that
// would leave the two ends less than 10 units apart, it sits on the anchor, as in Excalidraw, so a short arrow
// can't flip inside the shape. The guard works on both ends, so two shapes pushed together put both ends on their
// anchors. A curved arrow of three or more points docks where its curve meets the outline, so the drawn shaft
// meets the outline at the head.
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
    // An elbow end rests on its stored ratio alone, so it can't change side when the other end moves. A straight
    // end follows the line from its aim, as in Excalidraw.
    if (arrow.elbow) return elbowAnchorScene(shape, binding.fixedPoint);
    const anchor = anchorToScene(shape, binding.fixedPoint);
    const far = farSide(arrow, end, points, anchor, byId);
    const gap = bindingGap(shape);
    let endpoint = outlinePoint(shape, far.aim, anchor, gap);
    if (arrow.roundness === 'round' && points.length >= 3) {
        const dock = curveOutlineDock(arrow, end, shape, points, anchor, gap);
        if (dock) {
            // A dock that rounds to the stored endpoint returns that endpoint, so followBindings sees no change.
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

// The patch that docks an arrow's bound ends on the shapes as they are now, or null when nothing changed. Each new
// endpoint goes into the arrow's local frame about its old center, so a turned arrow's other vertices stay put.
// Taking the center of the new box instead would be circular.
export function followBindings(arrow: VectorArrowElement, byId: Map<string, VectorElement>): PinPatch | null {
    const start = boundShape(arrow.startBinding, byId);
    const end = boundShape(arrow.endBinding, byId);
    if (!start && !end) return null;
    const points = parsePoints(arrow.points);
    if (points.length < 2) return null;
    let patch: PinPatch;
    // An elbow arrow with pinned segments keeps its middle as it is. Only the bound ends move, with the short
    // segments that join them to the pins, and the router never runs.
    if (arrow.fixedSegments !== '') {
        const newStart = start ? boundEndpoint(arrow, 'start', start, byId) : null;
        const newEnd = end ? boundEndpoint(arrow, 'end', end, byId) : null;
        const moved = moveEndpoints(arrow, newStart, newEnd, elbowRoutingContext(arrow, byId));
        patch = renormalize({ ...arrow, ...moved });
    } else {
        // Any other arrow docks its two ends again. The docks and the box round to stored precision here, because
        // a box with a digit the stored points lack would drift by 1e-14 under a settled arrow.
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

// How near, in scene units, a dragged endpoint binds. Zoomed out it reaches further, up to twice as far, so the
// reach stays about the same on screen, as Excalidraw's maxBindingDistance_simple does.
export function bindingDistance(zoom: number): number {
    const z = Math.min(zoom, 1);
    return clamp(BASE_BINDING_DISTANCE / (z * 1.5), BASE_BINDING_DISTANCE, BASE_BINDING_DISTANCE * 2);
}

// A copied binding pointed at the copy of its shape, for a duplicate or a paste. A shape that wasn't copied
// clears the binding.
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
