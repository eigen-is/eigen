// The shape side of an elbow arrow, ported from Excalidraw. It picks the side a bound end leaves its shape by,
// gives a shape's bounds as the boxes the router works with, and finds the point on the outline where an elbow end
// docks when it binds. The router reads the headings and the bounds, and the drawing tools call the dock while an
// elbow end is dragged. Everything is in scene space, and shape angles are in degrees.

import {
    bindingAnchor,
    bindingGap,
    boundShape,
    elbowAnchorScene,
    normalizeFixedPoint,
    outlineIntersections,
} from './binding';
import type { Point } from './geometry';
import { boxCenter, getElementBounds, linearLocalToScene, rotatePoint } from './geometry';
import type { Heading } from './heading';
import {
    BASE_BINDING_GAP_ELBOW,
    HEADING_DOWN,
    HEADING_LEFT,
    HEADING_RIGHT,
    HEADING_UP,
    headingIsHorizontal,
    vectorToHeading,
} from './heading';
import { capabilitiesOf, ELEMENT_KINDS } from './kinds';
import { clamp, nearestPoint, outlineDistance } from './outline';
import { parsePoints } from './points';
import type { VectorArrowElement, VectorBindableElement, VectorElement } from './types';
import { parseBinding, serializeBinding } from './types';

// A bounds tuple [minX, minY, maxX, maxY], the shape of Excalidraw's Bounds. The router's box math reads much
// closer to its source in this form. The object Bounds from geometry is used where the router meets other code.
export type B4 = [number, number, number, number];

// How near a bound endpoint must sit to its shape for the cone test to pick its side. Excalidraw scales this with
// the zoom. The router has no zoom, because the server runs it too, so it uses Excalidraw's value at zoom 1.
const MAX_BINDING_DISTANCE = 15;

// The axis-aligned bounds of a shape's turned corners, optionally grown on each side. `offset` is Excalidraw's
// [top, right, down, left] tuple. That order differs from B4's, and it is the order offsetFromHeading builds.
export function aabbForElement(shape: VectorBindableElement, offset?: B4): B4 {
    const b = getElementBounds(shape);
    if (!offset) return [b.minX, b.minY, b.maxX, b.maxY];
    const [top, right, down, left] = offset;
    return [b.minX - left, b.minY - top, b.maxX + right, b.maxY + down];
}

// The heading a bound endpoint leaves its shape by, as Excalidraw's getHeadingForElbowArrowSnap. Far from the
// shape, it points from the shape's center to the endpoint. Close to it, a cone test on `aabb` picks the side.
// An unbound end has no shape, so it points at the other endpoint.
export function getHeadingForElbowArrowSnap(
    p: Point,
    otherPoint: Point,
    shape: VectorBindableElement | null,
    aabb: B4 | null,
): Heading {
    const otherPointHeading = vectorToHeading(otherPoint.x - p.x, otherPoint.y - p.y);
    if (!shape || !aabb) return otherPointHeading;

    // A degenerate outline reads a distance of 0, so it counts as near, like an endpoint on the edge.
    if (distanceToElement(shape, p) > MAX_BINDING_DISTANCE) {
        const c = boxCenter(shape);
        return vectorToHeading(p.x - c.x, p.y - c.y);
    }
    return headingForPointFromElement(shape, aabb, p);
}

// The distance from a scene point to a shape's outline, as Excalidraw's distanceToElement. It measures against the
// kind's own outline, so a rounded shape picks its heading and its side from the curve it draws.
export function distanceToElement(shape: VectorBindableElement, p: Point): number {
    const rp = rotatePoint(p, boxCenter(shape), -shape.angle);
    return outlineDistance(ELEMENT_KINDS[shape.type].outline(shape, 0), rp);
}

// The side a point near a shape belongs to, as Excalidraw's headingForPointFromElement. Four triangles run from the
// center of `aabb` to its corners, scaled twice as far out, and the one that holds the point names the side. A wide
// shape gets wide top and bottom cones. A diamond uses sectors around its vertices instead.
function headingForPointFromElement(shape: VectorBindableElement, aabb: B4, p: Point): Heading {
    if (capabilitiesOf(shape).silhouette === 'diamond') {
        return headingForPointFromDiamond(shape, aabb, p);
    }
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

// The diamond version, as Excalidraw's headingForPointFromDiamondElement. The four turned vertices, pulled in a
// little, carve a sector around each vertex and one along each side. A vertex sector points out through its vertex
// and wins over the side sectors. A side sector points out through the top or bottom vertex on a wide diamond, and
// through the left or right one on a tall diamond.
function headingForPointFromDiamond(shape: VectorBindableElement, aabb: B4, p: Point): Heading {
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

    if (cross(sub(p, top), sub(top, right)) <= 0 && cross(sub(p, top), sub(top, left)) > 0) return dirTo(top, mid);
    if (cross(sub(p, right), sub(right, bottom)) <= 0 && cross(sub(p, right), sub(right, top)) > 0)
        return dirTo(right, mid);
    if (cross(sub(p, bottom), sub(bottom, left)) <= 0 && cross(sub(p, bottom), sub(bottom, right)) > 0)
        return dirTo(bottom, mid);
    if (cross(sub(p, left), sub(left, top)) <= 0 && cross(sub(p, left), sub(left, bottom)) > 0) return dirTo(left, mid);

    if (cross(sub(p, mid), sub(top, mid)) <= 0 && cross(sub(p, mid), sub(right, mid)) > 0)
        return dirTo(wide ? top : right, mid);
    if (cross(sub(p, mid), sub(right, mid)) <= 0 && cross(sub(p, mid), sub(bottom, mid)) > 0)
        return dirTo(wide ? bottom : right, mid);
    if (cross(sub(p, mid), sub(bottom, mid)) <= 0 && cross(sub(p, mid), sub(left, mid)) > 0)
        return dirTo(wide ? bottom : left, mid);
    return dirTo(wide ? top : left, mid);
}

// The small vector helpers below stand in for Excalidraw's math package.

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

// A point exactly on an edge counts as inside, because only a mix of signs rules a point out. The cone test asks
// the top cone first, so a point on the line between two cones goes to the first one asked.
function triangleIncludesPoint(a: Point, b: Point, c: Point, p: Point): boolean {
    const sign = (p1: Point, p2: Point, p3: Point) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const d1 = sign(p, a, b);
    const d2 = sign(p, b, c);
    const d3 = sign(p, c, a);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}

// The code below docks an elbow end when it binds, as the elbow branch of Excalidraw's
// bindPointToSnapToElementOutline with its snapToMid and avoidRectangularCorner. An elbow end stores its fixedPoint
// from the dock, the point just outside the outline where the end snaps, and not from the raw cursor. That way the
// endpoint the user sees while dragging is exactly the one that is stored. At rest, elbowAnchorScene places the
// stored ratio back on the same dock.

// Excalidraw's MIN_BINDABLE_SIZE. A shape thinner than this has no inside to place a ratio in, so the end binds to
// the center and stays there when the shape is resized later.
const MIN_BINDABLE_SIZE = 1;
// Excalidraw's PRECISION. A crossing this close to the edge point counts as no snap.
const DOCK_PRECISION = 1e-4;

// Where a raw scene point docks on a shape for an elbow arrow, and the fixedPoint that stores it. `dock` is the
// endpoint the user sees, just outside the outline. `fixedPoint` is its ratio after normalizeFixedPoint, so it may
// sit a little outside [0, 1] and is never exactly 0.5.
export function elbowBindPoint(
    shape: VectorBindableElement,
    point: Point,
): { dock: Point; fixedPoint: [number, number] } {
    if (shape.width < MIN_BINDABLE_SIZE || shape.height < MIN_BINDABLE_SIZE) {
        const fixedPoint = normalizeFixedPoint([0.5, 0.5]);
        return { dock: elbowAnchorScene(shape, fixedPoint), fixedPoint };
    }
    const dock = elbowDock(shape, point);
    return { dock, fixedPoint: normalizeFixedPoint(bindingAnchor(shape, dock)) };
}

// The bindings of an arrow that just became an elbow arrow, docked again for the elbow read. A straight arrow
// stores the raw ratio of where its end was bound, and its read moves the end out onto the outline. The elbow read
// puts the ratio straight onto the box, so that raw ratio would rest the end inside the shape. Each bound end is
// docked again from where it sits now. The canvas runs followBindings after the patch, which puts both ends on the
// elbow path.
export function redockBindingsForElbow(
    arrow: VectorArrowElement,
    byId: Map<string, VectorElement>,
): { startBinding: string; endBinding: string } {
    const points = parsePoints(arrow.points);
    const redock = (binding: string, endLocal: Point | undefined): string => {
        const b = parseBinding(binding);
        if (!b || !endLocal) return binding;
        const shape = boundShape(binding, byId);
        if (!shape) return binding;
        const scene = linearLocalToScene(arrow, endLocal);
        return serializeBinding({ elementId: b.elementId, fixedPoint: elbowBindPoint(shape, scene).fixedPoint });
    };
    return {
        startBinding: redock(arrow.startBinding, points[0]),
        endBinding: redock(arrow.endBinding, points[points.length - 1]),
    };
}

// The dock for a raw point. On a box, the point first moves off a corner. It then snaps to the middle of a side when
// it is near one. A ray along the chosen axis then finds where it crosses the outline grown by the gap. When that
// ray misses, the other axis is tried with the smaller elbow gap, and when both miss the edge point is the dock.
function elbowDock(shape: VectorBindableElement, point: Point): Point {
    const gap = bindingGap(shape);
    const center = boxCenter(shape);
    const aabb = aabbForElement(shape);
    const boxy = capabilitiesOf(shape).silhouette === 'box';
    const edgePoint = boxy ? avoidRectangularCorner(shape, point, gap) : point;
    const isHorizontal = headingIsHorizontal(headingForPointFromElement(shape, aabb, point));
    const resolved = snapToMid(shape, edgePoint, 0.05, gap) ?? point;

    const intersection =
        dockIntersection(shape, center, resolved, isHorizontal, gap) ??
        dockIntersection(shape, center, resolved, !isHorizontal, BASE_BINDING_GAP_ELBOW);

    if (!intersection || distSq(edgePoint, intersection) < DOCK_PRECISION) return edgePoint;
    return intersection;
}

// Where a horizontal or vertical ray crosses the outline grown by `gap`. The ray starts on the shape's center line
// level with `resolved` and runs out through it. `isHorizontal` picks the ray's direction exactly as Excalidraw
// does. It returns null when `resolved` sits on the center line or the ray misses.
function dockIntersection(
    shape: VectorBindableElement,
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
    // A ray from inside the shape usually crosses one side. When it crosses two, the one nearest `resolved` wins,
    // which is the crossing Excalidraw's sort picks too.
    return hits.length === 0 ? null : nearestPoint(hits, resolved);
}

// Excalidraw's avoidRectangularCorner, for box shapes. A point in one of the four diagonal regions off a corner moves
// to just outside that corner, along one of its two sides, so the dock never lands on the sharp corner. The test
// runs in the shape's unturned frame, and the result is turned back.
function avoidRectangularCorner(shape: VectorBindableElement, p: Point, gap: number): Point {
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

// Excalidraw's snapToMid. A point near the line through the middle of a side snaps to the midpoint of that side,
// just outside it, so an end dragged near the middle of an edge locks there. The band is `tolerance` of the shape's
// size, and at least 5 and at most 80 units wide. A diamond also snaps near the middle of each sloped side. Like
// Excalidraw, it moves the center by 0.1 to break ties. It returns null when nothing snaps.
function snapToMid(shape: VectorBindableElement, p: Point, tolerance: number, gap: number): Point | null {
    const { x, y, width: w, height: h } = shape;
    const boxC = boxCenter(shape);
    const center = { x: boxC.x - 0.1, y: boxC.y - 0.1 };
    const np = rotatePoint(p, center, -shape.angle);
    const vThresh = clamp(tolerance * h, 5, 80);
    const hThresh = clamp(tolerance * w, 5, 80);
    const rot = (q: Point): Point => rotatePoint(q, center, shape.angle);
    // Near the center, the side a point belongs to is unclear.
    if (Math.hypot(center.x - np.x, center.y - np.y) < gap) return null;
    if (np.x <= x + w / 2 && np.y > center.y - vThresh && np.y < center.y + vThresh)
        return rot({ x: x - gap, y: center.y });
    if (np.y <= y + h / 2 && np.x > center.x - hThresh && np.x < center.x + hThresh)
        return rot({ x: center.x, y: y - gap });
    if (np.x >= x + w / 2 && np.y > center.y - vThresh && np.y < center.y + vThresh)
        return rot({ x: x + w + gap, y: center.y });
    if (np.y >= y + h / 2 && np.x > center.x - hThresh && np.x < center.x + hThresh)
        return rot({ x: center.x, y: y + h + gap });
    if (capabilitiesOf(shape).silhouette === 'diamond') {
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
