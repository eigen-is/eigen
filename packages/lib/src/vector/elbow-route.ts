// Elbow ("snake") arrow routing. The orthogonal polyline is DERIVED on every read/render — the model
// stores only an `elbow` flag, the two endpoints (arrow.points), and the bindings (R… UA4). Nothing about
// the route is persisted, so the server renderer (scene-to-svg) produces exactly what the canvas draws.
//
// Ported pragmatically from Excalidraw's elbowArrow.ts, trimmed to v1: obstacles are the two BOUND shapes'
// padded AABBs only (no user-pinned mid-segments, no fixedSegments). The core is grid + A*:
//   1. endpoint HEADINGS — a bound end points out of its shape along the fixedPoint's side; a free end
//      points toward the other endpoint;
//   2. a "dongle" is pushed off each endpoint along its heading, so the first/last segment leaves straight;
//   3. a small GRID is built from the sorted unique x/ys of the obstacle edges and the two dongles;
//   4. A* walks the grid dongle→dongle with a Manhattan heuristic and a bend penalty, refusing to enter an
//      obstacle or reverse direction; on failure a simple 1-bend L route is used (never throws).
// Everything is in the arrow's local frame (elbow arrows pin angle 0, so local = scene − (arrow.x, y)).

import { anchorToScene, type Bounds, getElementBounds, linearSceneToLocal, type Point, parsePoints } from './geometry';
import { isBindable, parseBinding, type VectorArrowElement, type VectorElement } from './types';

// How far outside an endpoint the route's first/last segment sticks straight before it may turn
// (Excalidraw's BASE_PADDING). Clearance is how far the obstacle AABB is inflated so the route stays off
// the outline; it is < the dongle offset so the dongle always sits outside the obstacle.
const ELBOW_PADDING = 40;
const ELBOW_CLEARANCE = 20;

type Heading = { x: number; y: number };

const HEADINGS: readonly Heading[] = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
];

// Excalidraw's vectorToHeading: snap a free vector to the dominant axis direction.
function vectorToHeading(dx: number, dy: number): Heading {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (dx > ay) return HEADINGS[0];
    if (dx <= -ay) return HEADINGS[1];
    if (dy > ax) return HEADINGS[2];
    return HEADINGS[3];
}

function isHorizontal(h: Heading): boolean {
    return h.y === 0;
}

function sameHeading(a: Heading, b: Heading): boolean {
    return a.x === b.x && a.y === b.y;
}

type BoundEnd = { aabb: Bounds; heading: Heading };

// Resolve a bound endpoint to its obstacle AABB (arrow-local) and outward heading. The heading is the
// direction from the shape's AABB centre to the anchor point (fixedPoint mapped onto the current shape),
// so it tracks the side the arrow leaves from — rotation and shrink included. null when unbound/missing.
function resolveBoundEnd(
    arrow: VectorArrowElement,
    bindingStr: string,
    byId: Map<string, VectorElement>,
): BoundEnd | null {
    const b = parseBinding(bindingStr);
    if (!b) return null;
    const shape = byId.get(b.elementId);
    if (!shape || !isBindable(shape)) return null;
    const scene = getElementBounds(shape);
    const min = linearSceneToLocal(arrow, { x: scene.minX, y: scene.minY });
    const max = linearSceneToLocal(arrow, { x: scene.maxX, y: scene.maxY });
    const aabb: Bounds = {
        minX: Math.min(min.x, max.x),
        minY: Math.min(min.y, max.y),
        maxX: Math.max(min.x, max.x),
        maxY: Math.max(min.y, max.y),
    };
    const anchor = linearSceneToLocal(arrow, anchorToScene(shape, b.fixedPoint));
    const cx = (aabb.minX + aabb.maxX) / 2;
    const cy = (aabb.minY + aabb.maxY) / 2;
    return { aabb, heading: vectorToHeading(anchor.x - cx, anchor.y - cy) };
}

// The derived orthogonal route of an elbow arrow, in its local frame: the two stored endpoints with a
// right-angled path routed between them. Deterministic and pure; degenerate (< 2 points) arrows pass
// through untouched. Obstacles are only the bound shapes — a fully unbound elbow is a plain L/Z route.
export function elbowRoute(arrow: VectorArrowElement, byId: Map<string, VectorElement>): Point[] {
    const pts = parsePoints(arrow.points);
    if (pts.length < 2) return pts;
    const start = pts[0];
    const end = pts[pts.length - 1];

    const startBound = resolveBoundEnd(arrow, arrow.startBinding, byId);
    const endBound = resolveBoundEnd(arrow, arrow.endBinding, byId);
    const startHeading = startBound ? startBound.heading : vectorToHeading(end.x - start.x, end.y - start.y);
    const endHeading = endBound ? endBound.heading : vectorToHeading(start.x - end.x, start.y - end.y);

    const obstacles: Bounds[] = [];
    if (startBound) obstacles.push(inflate(startBound.aabb, ELBOW_CLEARANCE));
    if (endBound) obstacles.push(inflate(endBound.aabb, ELBOW_CLEARANCE));

    const startDongle: Point = {
        x: start.x + startHeading.x * ELBOW_PADDING,
        y: start.y + startHeading.y * ELBOW_PADDING,
    };
    const endDongle: Point = { x: end.x + endHeading.x * ELBOW_PADDING, y: end.y + endHeading.y * ELBOW_PADDING };

    const middle =
        astar(startDongle, endDongle, startHeading, endHeading, obstacles) ??
        lRoute(startDongle, endDongle, startHeading);
    const route = simplify([start, ...middle, end]);
    return route.length >= 2 ? route : [start, end];
}

// The polyline an arrow draws/hits as: the derived orthogonal route for an elbow arrow (undefined without
// scene context, so callers fall back to the stored points), or undefined for a straight arrow. The single
// gate for "when does an elbow arrow get a derived route" — every render path (live canvas, previews,
// export) routes through here so none can silently degrade an elbow arrow back to a straight line.
export function arrowRoute(el: VectorElement, byId?: Map<string, VectorElement>): Point[] | undefined {
    return el.type === 'arrow' && el.elbow && byId ? elbowRoute(el, byId) : undefined;
}

// --- grid + A* -------------------------------------------------------------------------

type Node = {
    x: number;
    y: number;
    col: number;
    row: number;
    g: number;
    f: number;
    visited: boolean;
    closed: boolean;
    parent: Node | null;
    heading: Heading | null; // the direction taken to reach this node
};

function astar(
    startPt: Point,
    endPt: Point,
    startHeading: Heading,
    endHeading: Heading,
    obstacles: Bounds[],
): Point[] | null {
    const xs = uniqueSorted([startPt.x, endPt.x, ...obstacles.flatMap((o) => [o.minX, o.maxX])]);
    const ys = uniqueSorted([startPt.y, endPt.y, ...obstacles.flatMap((o) => [o.minY, o.maxY])]);
    const cols = xs.length;
    const grid: Node[] = ys.flatMap((y, row) =>
        xs.map(
            (x, col): Node => ({
                x,
                y,
                col,
                row,
                g: 0,
                f: 0,
                visited: false,
                closed: false,
                parent: null,
                heading: null,
            }),
        ),
    );
    const at = (col: number, row: number): Node | null =>
        col < 0 || col >= cols || row < 0 || row >= ys.length ? null : grid[row * cols + col];
    const find = (p: Point): Node | null => grid.find((n) => n.x === p.x && n.y === p.y) ?? null;

    const start = find(startPt);
    const end = find(endPt);
    if (!start || !end) return null;

    // A bend must cost more than any bend-free traversal so the route minimises turns first, length second.
    const bendPenalty = (manhattan(startPt, endPt) + 1) ** 3;
    start.heading = startHeading;
    start.visited = true;
    const open: Node[] = [start];

    while (open.length > 0) {
        let bestI = 0;
        for (let i = 1; i < open.length; i++) {
            if (open[i].f < open[bestI].f) bestI = i;
        }
        const current = open.splice(bestI, 1)[0];
        if (current === end) return reconstruct(current);
        current.closed = true;

        for (const [dc, dr] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ]) {
            const neighbor = at(current.col + dc, current.row + dr);
            if (!neighbor || neighbor.closed) continue;
            const step = vectorToHeading(neighbor.x - current.x, neighbor.y - current.y);
            // No U-turns; and never arrive at the end dongle heading further outward (it would force the
            // final endpoint segment to reverse the last turn).
            if (current.heading && sameHeading(step, flip(current.heading))) continue;
            if (neighbor === end && sameHeading(step, endHeading)) continue;
            if (obstacles.some((o) => strictlyInside(midpoint(current, neighbor), o))) continue;

            const turned = current.heading !== null && !sameHeading(step, current.heading);
            const g = current.g + manhattan(current, neighbor) + (turned ? bendPenalty : 0);
            if (neighbor.visited && g >= neighbor.g) continue;
            neighbor.visited = true;
            neighbor.parent = current;
            neighbor.heading = step;
            neighbor.g = g;
            neighbor.f = g + manhattan(neighbor, end);
            if (!open.includes(neighbor)) open.push(neighbor);
        }
    }
    return null;
}

function reconstruct(node: Node): Point[] {
    const path: Point[] = [];
    let cur: Node | null = node;
    while (cur) {
        path.unshift({ x: cur.x, y: cur.y });
        cur = cur.parent;
    }
    return path;
}

// Fallback when A* finds no grid route: a single right-angle turn between the dongles, first segment along
// the start heading's axis. simplify() collapses it to a straight segment when the dongles already align.
// This L may cut straight through an obstacle AABB — by design: a guaranteed-drawn route beats none when
// the grid search is boxed in.
function lRoute(a: Point, b: Point, startHeading: Heading): Point[] {
    const corner: Point = isHorizontal(startHeading) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    return [a, corner, b];
}

// Drop repeated points and collinear midpoints, leaving only the true corners.
function simplify(pts: Point[]): Point[] {
    const out: Point[] = [];
    for (const p of pts) {
        const last = out[out.length - 1];
        if (last && last.x === p.x && last.y === p.y) continue;
        out.push(p);
        if (out.length >= 3) {
            const a = out[out.length - 3];
            const b = out[out.length - 2];
            const c = out[out.length - 1];
            if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(out.length - 2, 1);
        }
    }
    return out;
}

function uniqueSorted(values: number[]): number[] {
    return [...new Set(values)].sort((a, b) => a - b);
}

function manhattan(a: Point, b: Point): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function flip(h: Heading): Heading {
    return { x: -h.x, y: -h.y };
}

function inflate(b: Bounds, gap: number): Bounds {
    return { minX: b.minX - gap, minY: b.minY - gap, maxX: b.maxX + gap, maxY: b.maxY + gap };
}

function strictlyInside(p: Point, b: Bounds): boolean {
    return p.x > b.minX && p.x < b.maxX && p.y > b.minY && p.y < b.maxY;
}
