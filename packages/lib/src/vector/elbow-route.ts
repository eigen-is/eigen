// Elbow ("snake") arrow routing. The orthogonal polyline is DERIVED on every read/render — the model stores
// only an `elbow` flag, the two endpoints (arrow.points), and the bindings. Nothing about the route is
// persisted, so the server renderer (scene-to-svg) produces exactly what the canvas draws.
//
// Ported to be point-identical to Excalidraw's no-fixed-segments path (packages/element/src/elbowArrow.ts,
// dispatch case 2): resolve each endpoint and its outward heading (elbow-heading.ts), grow a dynamic obstacle
// AABB per bound end that reaches toward the other shape, push a "dongle" onto each box edge, build a
// non-uniform grid from the box + common-bounds edges, and A* dongle→dongle with a bend-count heuristic and a
// binary heap. Post-passes drop sub-pixel segments and keep only true corners. Their null-route crash path
// becomes our guaranteed-draw L fallback (the arrow must always render). `fixedSegments` and the drag-time
// live-dock (getElbowArrowData's isDragging branch) are out of scope.
//
// Everything runs in SCENE coordinates (elbow arrows pin angle 0, so the derived local frame is a pure
// translation) and is converted to the arrow's local frame once at the end.

import {
    aabbForElement,
    type B4,
    compareHeading,
    distanceToElement,
    flipHeading,
    getHeadingForElbowArrowSnap,
    HEADING_DOWN,
    HEADING_LEFT,
    HEADING_RIGHT,
    HEADING_UP,
    type Heading,
    headingIsHorizontal,
    vectorToHeading,
} from './elbow-heading';
import type { PinRoutingContext } from './elbow-pins';
import { boundShape, linearLocalToScene, linearSceneToLocal, type Point, parsePoints } from './geometry';
import type { VectorArrowElement, VectorElement, VectorShapeElement } from './types';

// Excalidraw's BASE_PADDING / BASE_BINDING_GAP_ELBOW / DEDUP_TRESHOLD.
const BASE_PADDING = 40;
const BASE_BINDING_GAP_ELBOW = 5;
const DEDUP_THRESHOLD = 1;

// The derived orthogonal route of an elbow arrow, in its local frame: the two stored endpoints with a
// right-angled path routed between them. The route ALWAYS starts at points[0] and ends at points[last]
// exactly — the endpoint dot and the shaft share that one value. Deterministic and pure; degenerate
// (< 2 points) arrows pass through untouched. Obstacles are only the bound shapes.
// `origPoints`: the PRE-DOCK scene point per end, distinct from the stored/docked endpoint, used only to
// gate the heading cone by distance (getHeadingForElbowArrowSnap). At rest the stored point IS the dock, so
// callers omit it and it defaults to the stored globals; during an endpoint drag the caller passes the raw cursor
// so the exit side follows the anchor, not the gliding dock, exactly as Excalidraw does.
export function elbowRoute(
    arrow: VectorArrowElement,
    byId: Map<string, VectorElement>,
    origPoints?: { start?: Point; end?: Point },
): Point[] {
    const pts = parsePoints(arrow.points);
    if (pts.length < 2) return pts;

    const startShape = boundShape(arrow.startBinding, byId);
    const endShape = boundShape(arrow.endBinding, byId);

    // The drawn route MUST begin and end on the stored endpoints — the very points the endpoint dot renders
    // at (linearLocalToScene of points[0]/points[last]) — so the shaft and the dot never diverge (one source
    // of truth for where the arrow attaches). Excalidraw keeps its stored points in sync with the
    // fixedPoint-derived dock and routes from that; here that sync is boundEndpoint's job (it will write the
    // dock into the stored point), so this router routes from whatever endpoint is stored today and never overwrites
    // it. These scene points are also the "original" point Excalidraw's heading test consumes.
    const startGlobal = linearLocalToScene(arrow, pts[0]);
    const endGlobal = linearLocalToScene(arrow, pts[pts.length - 1]);

    const startArrowhead = arrow.startArrowhead !== 'none';
    const endArrowhead = arrow.endArrowhead !== 'none';

    // The single derived route (DERIVED mode only — a pinned arrow never reaches here; arrowRoute returns
    // its stored polyline verbatim).
    const startEnd: LegEnd = {
        point: startGlobal,
        shape: startShape,
        arrowhead: startArrowhead,
        orig: origPoints?.start ?? startGlobal,
    };
    const endEnd: LegEnd = {
        point: endGlobal,
        shape: endShape,
        arrowhead: endArrowhead,
        orig: origPoints?.end ?? endGlobal,
    };
    const routeScene = routeSceneLeg(startEnd, endEnd, !!arrow.startBinding);

    const corners = getElbowArrowCornerPoints(removeElbowArrowShortSegments(routeScene));
    const local = corners.map((p) => linearSceneToLocal(arrow, p));
    return local.length >= 2 ? local : [linearSceneToLocal(arrow, startGlobal), linearSceneToLocal(arrow, endGlobal)];
}

// One end of a routing leg — a real bound shape (heading from the cone) or a free endpoint (heading toward
// the other end). A pinned arrow never routes here — its stored polyline is returned verbatim.
type LegEnd = {
    point: Point;
    shape: VectorShapeElement | null;
    arrowhead: boolean;
    orig: Point;
};

// Route one leg in scene space (endpoints included), never null: the guaranteed-draw L fallback stands in
// when A* is walled. The shared core of both the no-pin route and every connector leg of a pinned route.
function routeSceneLeg(start: LegEnd, end: LegEnd, startBinding: boolean): Point[] {
    const data = getElbowArrowData(
        {
            startShape: start.shape,
            endShape: end.shape,
            startGlobal: start.point,
            endGlobal: end.point,
            startArrowhead: start.arrowhead,
            endArrowhead: end.arrowhead,
            origStart: start.orig,
            origEnd: end.orig,
        },
        startBinding,
    );
    return routeElbowArrow(data) ?? lRoute(start.point, end.point, data.startHeading);
}

// The polyline an arrow draws/hits as: the derived orthogonal route for an elbow arrow (undefined without
// scene context, so callers fall back to the stored points), or undefined for a straight arrow. The single
// gate for "when does an elbow arrow get a derived route" — every render path (live canvas, previews, export)
// routes through here so none can silently degrade an elbow arrow back to a straight line.
export function arrowRoute(el: VectorElement, byId?: Map<string, VectorElement>): Point[] | undefined {
    if (el.type !== 'arrow' || !el.elbow) return undefined;
    // PINNED: the stored polyline IS the route — no router, no corner/short passes. The incremental
    // editors (elbow-pins.ts) own it; every render path returns it verbatim so preview===commit holds.
    if (el.fixedSegments !== '') return parsePoints(el.points);
    // DERIVED: route the two endpoints (needs scene context for bound obstacles/headings).
    return byId ? elbowRoute(el, byId) : undefined;
}

// --- routing data (Excalidraw's getElbowArrowData, at-rest branch) ---------------------

type RouteInputs = {
    startShape: VectorShapeElement | null;
    endShape: VectorShapeElement | null;
    startGlobal: Point;
    endGlobal: Point;
    startArrowhead: boolean;
    endArrowhead: boolean;
    // The pre-dock scene point per end for the heading distance-gate; equals the stored global at rest.
    origStart: Point;
    origEnd: Point;
};

type ElbowArrowData = {
    dynamicAABBs: B4[];
    startDongle: Point;
    startGlobal: Point;
    startHeading: Heading;
    endDongle: Point;
    endGlobal: Point;
    endHeading: Heading;
    commonBounds: B4;
    startBound: boolean;
    endBound: boolean;
};

// The heading each endpoint leaves its shape by (Excalidraw's getElbowArrowData heading block): a bound end
// inflates its element by the endpoint's distance to the outline (the cone AABB) and the distance-GATE keys
// on origStart/origEnd; an unbound end just points at the other endpoint. One source for both the router and
// the pin-drag routing context.
function endpointHeadings(
    startShape: VectorShapeElement | null,
    endShape: VectorShapeElement | null,
    startGlobal: Point,
    endGlobal: Point,
    origStart: Point,
    origEnd: Point,
): { startHeading: Heading; endHeading: Heading } {
    const startConeAABB = startShape
        ? aabbForElement(startShape, fill4(distanceToElement(startShape, startGlobal)))
        : null;
    const endConeAABB = endShape ? aabbForElement(endShape, fill4(distanceToElement(endShape, endGlobal))) : null;
    return {
        startHeading: getHeadingForElbowArrowSnap(startGlobal, endGlobal, startShape, startConeAABB, origStart),
        endHeading: getHeadingForElbowArrowSnap(endGlobal, startGlobal, endShape, endConeAABB, origEnd),
    };
}

// The routing context an end-segment pin jog needs — the two endpoint headings decomposed into
// horizontal?/positive? plus per-end bound flags — computed at the call seam so elbow-pins stays pure.
// Uses the arrow's stored endpoints at rest (origStart/origEnd = the endpoints themselves).
export function elbowRoutingContext(arrow: VectorArrowElement, byId: Map<string, VectorElement>): PinRoutingContext {
    const startShape = boundShape(arrow.startBinding, byId);
    const endShape = boundShape(arrow.endBinding, byId);
    const pts = parsePoints(arrow.points);
    const startGlobal = linearLocalToScene(arrow, pts[0]);
    const endGlobal = linearLocalToScene(arrow, pts[pts.length - 1]);
    const { startHeading, endHeading } = endpointHeadings(
        startShape,
        endShape,
        startGlobal,
        endGlobal,
        startGlobal,
        endGlobal,
    );
    const horizontal = (h: Heading): boolean => headingIsHorizontal(h);
    const positive = (h: Heading): boolean =>
        headingIsHorizontal(h) ? compareHeading(h, HEADING_RIGHT) : compareHeading(h, HEADING_DOWN);
    return {
        startBound: !!startShape,
        endBound: !!endShape,
        startHeadingHorizontal: horizontal(startHeading),
        startHeadingPositive: positive(startHeading),
        endHeadingHorizontal: horizontal(endHeading),
        endHeadingPositive: positive(endHeading),
    };
}

function getElbowArrowData(input: RouteInputs, startBinding: boolean): ElbowArrowData {
    const { startShape, endShape, startGlobal, endGlobal, startArrowhead, endArrowhead, origStart, origEnd } = input;

    // Heading cone AABB is the element inflated on all sides by the endpoint's distance to the outline. The
    // cone geometry keys on the rest/docked endpoint; the distance-GATE keys on the pre-dock original point
    // (origStart/origEnd — equal to the stored endpoint at rest), so a dragged dock gliding on the
    // outline doesn't flip the exit side under the anchor.
    const { startHeading, endHeading } = endpointHeadings(
        startShape,
        endShape,
        startGlobal,
        endGlobal,
        origStart,
        origEnd,
    );

    const startPointBounds = pointBounds(startGlobal);
    const endPointBounds = pointBounds(endGlobal);

    // Obstacle base per end: the element AABB pushed out on the heading side by gap·6 (arrowhead) or gap·2,
    // and by 1 elsewhere; an unbound end contributes only its ±2 point box.
    const startElementBounds = startShape
        ? aabbForElement(startShape, offsetFromHeading(startHeading, headGap(startShape, startArrowhead), 1))
        : startPointBounds;
    const endElementBounds = endShape
        ? aabbForElement(endShape, offsetFromHeading(endHeading, headGap(endShape, endArrowhead), 1))
        : endPointBounds;

    // Overlap: an endpoint sitting inside the other end's BASE_PADDING box collapses both obstacles to their
    // point boxes so a route between overlapping shapes still exists.
    const boundsOverlap =
        pointInside(
            startGlobal,
            endShape
                ? aabbForElement(endShape, offsetFromHeading(endHeading, BASE_PADDING, BASE_PADDING))
                : endPointBounds,
        ) ||
        pointInside(
            endGlobal,
            startShape
                ? aabbForElement(startShape, offsetFromHeading(startHeading, BASE_PADDING, BASE_PADDING))
                : startPointBounds,
        );

    const bothUnbound = !startShape && !endShape;
    const commonBounds = commonAABB(
        boundsOverlap ? [startPointBounds, endPointBounds] : [startElementBounds, endElementBounds],
    );
    const dynamicAABBs = generateDynamicAABBs(
        boundsOverlap ? startPointBounds : startElementBounds,
        boundsOverlap ? endPointBounds : endElementBounds,
        commonBounds,
        boundsOverlap
            ? offsetFromHeading(startHeading, bothUnbound ? 0 : BASE_PADDING, 0)
            : offsetFromHeading(
                  startHeading,
                  bothUnbound ? 0 : BASE_PADDING - BASE_BINDING_GAP_ELBOW * (startArrowhead ? 6 : 2),
                  BASE_PADDING,
              ),
        boundsOverlap
            ? offsetFromHeading(endHeading, bothUnbound ? 0 : BASE_PADDING, 0)
            : offsetFromHeading(
                  endHeading,
                  bothUnbound ? 0 : BASE_PADDING - BASE_BINDING_GAP_ELBOW * (endArrowhead ? 6 : 2),
                  BASE_PADDING,
              ),
        boundsOverlap,
        startShape ? aabbForElement(startShape) : null,
        endShape ? aabbForElement(endShape) : null,
    );

    return {
        dynamicAABBs,
        startDongle: getDonglePosition(dynamicAABBs[0], startHeading, startGlobal),
        startGlobal,
        startHeading,
        endDongle: getDonglePosition(dynamicAABBs[1], endHeading, endGlobal),
        endGlobal,
        endHeading,
        commonBounds,
        startBound: startBinding,
        endBound: !!endShape,
    };
}

// gap·6 when the end carries an arrowhead, else gap·2 (Excalidraw's getBindingGap · {6,2}); gap = 5 + w/2.
function headGap(shape: VectorShapeElement, hasArrowhead: boolean): number {
    return (BASE_BINDING_GAP_ELBOW + shape.strokeWidth / 2) * (hasArrowhead ? 6 : 2);
}

function pointBounds(p: Point): B4 {
    return [p.x - 2, p.y - 2, p.x + 2, p.y + 2];
}

function fill4(v: number): B4 {
    return [v, v, v, v];
}

// --- route assembly (Excalidraw's routeElbowArrow) -------------------------------------

function routeElbowArrow(data: ElbowArrowData): Point[] | null {
    const {
        dynamicAABBs,
        startDongle,
        startGlobal,
        startHeading,
        endDongle,
        endGlobal,
        endHeading,
        commonBounds,
        startBound,
        endBound,
    } = data;

    const grid = calculateGrid(dynamicAABBs, startDongle, startHeading, endDongle, endHeading, commonBounds);

    const startDongleNode = pointToGridNode(startDongle, grid);
    const endDongleNode = pointToGridNode(endDongle, grid);

    // Do not allow stepping on the true endpoints when they anchor a bound shape.
    const endNode = pointToGridNode(endGlobal, grid);
    if (endNode && endBound) endNode.closed = true;
    const startNode = pointToGridNode(startGlobal, grid);
    if (startNode && startBound) startNode.closed = true;

    const start = startDongleNode ?? startNode;
    const end = endDongleNode ?? endNode;
    if (!start || !end) return null;

    const dongleOverlap =
        startDongleNode &&
        endDongleNode &&
        (pointInside(startDongleNode.pos, dynamicAABBs[1]) || pointInside(endDongleNode.pos, dynamicAABBs[0]));

    const path = astar(start, end, grid, startHeading, endHeading, dongleOverlap ? [] : dynamicAABBs);
    if (!path) return null;

    const points = path.map((node) => node.pos);
    if (startDongleNode) points.unshift(startGlobal);
    if (endDongleNode) points.push(endGlobal);
    return points;
}

// Excalidraw's offsetFromHeading: put `head` on the heading side, `side` on the other three. Order is
// [top, right, down, left] — the order aabbForElement expects.
function offsetFromHeading(heading: Heading, head: number, side: number): B4 {
    if (compareHeading(heading, HEADING_UP)) return [head, side, side, side];
    if (compareHeading(heading, HEADING_RIGHT)) return [side, head, side, side];
    if (compareHeading(heading, HEADING_DOWN)) return [side, side, head, side];
    return [side, side, side, head];
}

// Create dynamically resizing, always-touching obstacle boxes: each grows toward the other only to the
// midline between the two elements, is padded per heading, and — unless disabled (overlap) — is split along
// the side-hack midline when the two padded boxes would overlap diagonally. Ported verbatim from Excalidraw's
// generateDynamicAABBs; the nested ternaries are theirs (each picks midline vs padded-edge vs common-edge).
function generateDynamicAABBs(
    a: B4,
    b: B4,
    common: B4,
    startDifference: B4,
    endDifference: B4,
    disableSideHack: boolean,
    startElementBounds: B4 | null,
    endElementBounds: B4 | null,
): B4[] {
    const startEl = startElementBounds ?? a;
    const endEl = endElementBounds ?? b;
    const [startUp, startRight, startDown, startLeft] = startDifference;
    const [endUp, endRight, endDown, endLeft] = endDifference;

    const first: B4 = [
        a[0] > b[2]
            ? a[1] > b[3] || a[3] < b[1]
                ? Math.min((startEl[0] + endEl[2]) / 2, a[0] - startLeft)
                : (startEl[0] + endEl[2]) / 2
            : a[0] > b[0]
              ? a[0] - startLeft
              : common[0] - startLeft,
        a[1] > b[3]
            ? a[0] > b[2] || a[2] < b[0]
                ? Math.min((startEl[1] + endEl[3]) / 2, a[1] - startUp)
                : (startEl[1] + endEl[3]) / 2
            : a[1] > b[1]
              ? a[1] - startUp
              : common[1] - startUp,
        a[2] < b[0]
            ? a[1] > b[3] || a[3] < b[1]
                ? Math.max((startEl[2] + endEl[0]) / 2, a[2] + startRight)
                : (startEl[2] + endEl[0]) / 2
            : a[2] < b[2]
              ? a[2] + startRight
              : common[2] + startRight,
        a[3] < b[1]
            ? a[0] > b[2] || a[2] < b[0]
                ? Math.max((startEl[3] + endEl[1]) / 2, a[3] + startDown)
                : (startEl[3] + endEl[1]) / 2
            : a[3] < b[3]
              ? a[3] + startDown
              : common[3] + startDown,
    ];
    const second: B4 = [
        b[0] > a[2]
            ? b[1] > a[3] || b[3] < a[1]
                ? Math.min((endEl[0] + startEl[2]) / 2, b[0] - endLeft)
                : (endEl[0] + startEl[2]) / 2
            : b[0] > a[0]
              ? b[0] - endLeft
              : common[0] - endLeft,
        b[1] > a[3]
            ? b[0] > a[2] || b[2] < a[0]
                ? Math.min((endEl[1] + startEl[3]) / 2, b[1] - endUp)
                : (endEl[1] + startEl[3]) / 2
            : b[1] > a[1]
              ? b[1] - endUp
              : common[1] - endUp,
        b[2] < a[0]
            ? b[1] > a[3] || b[3] < a[1]
                ? Math.max((endEl[2] + startEl[0]) / 2, b[2] + endRight)
                : (endEl[2] + startEl[0]) / 2
            : b[2] < a[2]
              ? b[2] + endRight
              : common[2] + endRight,
        b[3] < a[1]
            ? b[0] > a[2] || b[2] < a[0]
                ? Math.max((endEl[3] + startEl[1]) / 2, b[3] + endDown)
                : (endEl[3] + startEl[1]) / 2
            : b[3] < a[3]
              ? b[3] + endDown
              : common[3] + endDown,
    ];

    const c = commonAABB([first, second]);
    if (
        !disableSideHack &&
        first[2] - first[0] + (second[2] - second[0]) > c[2] - c[0] + 0.00000000001 &&
        first[3] - first[1] + (second[3] - second[1]) > c[3] - c[1] + 0.00000000001
    ) {
        const endCenterX = (second[0] + second[2]) / 2;
        const endCenterY = (second[1] + second[3]) / 2;
        if (b[0] > a[2] && a[1] > b[3]) {
            // BOTTOM LEFT
            const cX = first[2] + (second[0] - first[2]) / 2;
            const cY = second[3] + (first[1] - second[3]) / 2;
            if (crossXY(a[2] - endCenterX, a[1] - endCenterY, a[0] - endCenterX, a[3] - endCenterY) > 0) {
                return [
                    [first[0], first[1], cX, first[3]],
                    [cX, second[1], second[2], second[3]],
                ];
            }
            return [
                [first[0], cY, first[2], first[3]],
                [second[0], second[1], second[2], cY],
            ];
        }
        if (a[2] < b[0] && a[3] < b[1]) {
            // TOP LEFT
            const cX = first[2] + (second[0] - first[2]) / 2;
            const cY = first[3] + (second[1] - first[3]) / 2;
            if (crossXY(a[0] - endCenterX, a[1] - endCenterY, a[2] - endCenterX, a[3] - endCenterY) > 0) {
                return [
                    [first[0], first[1], first[2], cY],
                    [second[0], cY, second[2], second[3]],
                ];
            }
            return [
                [first[0], first[1], cX, first[3]],
                [cX, second[1], second[2], second[3]],
            ];
        }
        if (a[0] > b[2] && a[3] < b[1]) {
            // TOP RIGHT
            const cX = second[2] + (first[0] - second[2]) / 2;
            const cY = first[3] + (second[1] - first[3]) / 2;
            if (crossXY(a[2] - endCenterX, a[1] - endCenterY, a[0] - endCenterX, a[3] - endCenterY) > 0) {
                return [
                    [cX, first[1], first[2], first[3]],
                    [second[0], second[1], cX, second[3]],
                ];
            }
            return [
                [first[0], first[1], first[2], cY],
                [second[0], cY, second[2], second[3]],
            ];
        }
        if (a[0] > b[2] && a[1] > b[3]) {
            // BOTTOM RIGHT
            const cX = second[2] + (first[0] - second[2]) / 2;
            const cY = second[3] + (first[1] - second[3]) / 2;
            if (crossXY(a[0] - endCenterX, a[1] - endCenterY, a[2] - endCenterX, a[3] - endCenterY) > 0) {
                return [
                    [cX, first[1], first[2], first[3]],
                    [second[0], second[1], cX, second[3]],
                ];
            }
            return [
                [first[0], cY, first[2], first[3]],
                [second[0], second[1], second[2], cY],
            ];
        }
    }
    return [first, second];
}

function commonAABB(boxes: B4[]): B4 {
    return [
        Math.min(...boxes.map((x) => x[0])),
        Math.min(...boxes.map((x) => x[1])),
        Math.max(...boxes.map((x) => x[2])),
        Math.max(...boxes.map((x) => x[3])),
    ];
}

// --- grid -------------------------------------------------------------------------------

type Node = {
    f: number;
    g: number;
    h: number;
    closed: boolean;
    visited: boolean;
    parent: Node | null;
    pos: Point;
    col: number;
    row: number;
};

type Grid = { cols: number; rows: number; data: Node[] };

// Grid lines at the dynamic-AABB edges + common-bounds edges, plus the single cross-axis coordinate of each
// endpoint (its along-axis coordinate already lies on a box edge). A non-uniform grid — Excalidraw's
// calculateGrid.
function calculateGrid(
    aabbs: B4[],
    start: Point,
    startHeading: Heading,
    end: Point,
    endHeading: Heading,
    common: B4,
): Grid {
    const xs = new Set<number>();
    const ys = new Set<number>();

    if (headingIsHorizontal(startHeading)) ys.add(start.y);
    else xs.add(start.x);
    if (headingIsHorizontal(endHeading)) ys.add(end.y);
    else xs.add(end.x);

    for (const aabb of aabbs) {
        xs.add(aabb[0]);
        xs.add(aabb[2]);
        ys.add(aabb[1]);
        ys.add(aabb[3]);
    }
    xs.add(common[0]);
    xs.add(common[2]);
    ys.add(common[1]);
    ys.add(common[3]);

    const sortedX = [...xs].sort((p, q) => p - q);
    const sortedY = [...ys].sort((p, q) => p - q);
    const cols = sortedX.length;
    const data = sortedY.flatMap((y, row) =>
        sortedX.map(
            (x, col): Node => ({
                f: 0,
                g: 0,
                h: 0,
                closed: false,
                visited: false,
                parent: null,
                pos: { x, y },
                col,
                row,
            }),
        ),
    );
    return { cols, rows: sortedY.length, data };
}

function nodeAt(col: number, row: number, grid: Grid): Node | null {
    if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
    return grid.data[row * grid.cols + col] ?? null;
}

function pointToGridNode(p: Point, grid: Grid): Node | null {
    return grid.data.find((n) => n.pos.x === p.x && n.pos.y === p.y) ?? null;
}

// Project the endpoint onto the dynamic AABB edge along its heading — the dongle lies on the box edge.
function getDonglePosition(bounds: B4, heading: Heading, p: Point): Point {
    if (compareHeading(heading, HEADING_UP)) return { x: p.x, y: bounds[1] };
    if (compareHeading(heading, HEADING_RIGHT)) return { x: bounds[2], y: p.y };
    if (compareHeading(heading, HEADING_DOWN)) return { x: p.x, y: bounds[3] };
    return { x: bounds[0], y: p.y };
}

// --- A* --------------------------------------------------------------------------------

class BinaryHeap {
    private content: Node[] = [];

    private sinkDown(idx: number): void {
        const node = this.content[idx];
        while (idx > 0) {
            const parentN = ((idx + 1) >> 1) - 1;
            const parent = this.content[parentN];
            if (node.f < parent.f) {
                this.content[idx] = parent;
                idx = parentN;
            } else break;
        }
        this.content[idx] = node;
    }

    private bubbleUp(idx: number): void {
        const length = this.content.length;
        const node = this.content[idx];
        for (;;) {
            const child1N = ((idx + 1) << 1) - 1;
            const child2N = child1N + 1;
            let smallest = idx;
            let smallestScore = node.f;
            if (child1N < length && this.content[child1N].f < smallestScore) {
                smallest = child1N;
                smallestScore = this.content[child1N].f;
            }
            if (child2N < length && this.content[child2N].f < smallestScore) {
                smallest = child2N;
            }
            if (smallest === idx) break;
            this.content[idx] = this.content[smallest];
            idx = smallest;
        }
        this.content[idx] = node;
    }

    push(node: Node): void {
        this.content.push(node);
        this.sinkDown(this.content.length - 1);
    }

    pop(): Node | null {
        if (this.content.length === 0) return null;
        const result = this.content[0];
        const end = this.content.pop();
        if (end && this.content.length > 0) {
            this.content[0] = end;
            this.bubbleUp(0);
        }
        return result;
    }

    size(): number {
        return this.content.length;
    }

    rescore(node: Node): void {
        this.sinkDown(this.content.indexOf(node));
    }
}

// A* over the grid, dongle→dongle. A direction change costs bendMultiplier³ (bendMultiplier = the dongles'
// Manhattan distance), the heuristic adds the estimated remaining bends × bendMultiplier², a segment whose
// midpoint falls strictly inside any obstacle is banned, and the route may not reverse the previous direction
// or re-enter the start/end nodes along their own heading. Neighbor order UP, RIGHT, DOWN, LEFT.
function astar(
    start: Node,
    end: Node,
    grid: Grid,
    startHeading: Heading,
    endHeading: Heading,
    obstacles: B4[],
): Node[] | null {
    const bendMultiplier = manhattan(start.pos, end.pos);
    const open = new BinaryHeap();
    open.push(start);

    while (open.size() > 0) {
        const current = open.pop();
        if (!current || current.closed) continue;
        if (current === end) return pathTo(start, current);
        current.closed = true;

        const neighbors = [
            nodeAt(current.col, current.row - 1, grid),
            nodeAt(current.col + 1, current.row, grid),
            nodeAt(current.col, current.row + 1, grid),
            nodeAt(current.col - 1, current.row, grid),
        ];

        for (let i = 0; i < 4; i++) {
            const neighbor = neighbors[i];
            if (!neighbor || neighbor.closed) continue;

            const half = { x: (current.pos.x + neighbor.pos.x) / 2, y: (current.pos.y + neighbor.pos.y) / 2 };
            if (obstacles.some((aabb) => pointInside(half, aabb))) continue;

            const neighborHeading = neighborIndexToHeading(i);
            const previousDirection = current.parent
                ? vectorToHeading(current.pos.x - current.parent.pos.x, current.pos.y - current.parent.pos.y)
                : startHeading;

            const reverse =
                compareHeading(flipHeading(previousDirection), neighborHeading) ||
                (nodesEqual(start, neighbor) && compareHeading(neighborHeading, startHeading)) ||
                (nodesEqual(end, neighbor) && compareHeading(neighborHeading, endHeading));
            if (reverse) continue;

            const directionChange = !compareHeading(previousDirection, neighborHeading);
            const gScore =
                current.g + manhattan(neighbor.pos, current.pos) + (directionChange ? bendMultiplier ** 3 : 0);

            const beenVisited = neighbor.visited;
            if (!beenVisited || gScore < neighbor.g) {
                const estBends = estimateSegmentCount(neighbor, end, neighborHeading, endHeading);
                neighbor.visited = true;
                neighbor.parent = current;
                neighbor.h = manhattan(end.pos, neighbor.pos) + estBends * bendMultiplier ** 2;
                neighbor.g = gScore;
                neighbor.f = neighbor.g + neighbor.h;
                if (!beenVisited) open.push(neighbor);
                else open.rescore(neighbor);
            }
        }
    }
    return null;
}

function pathTo(start: Node, node: Node): Node[] {
    const path: Node[] = [];
    let cur: Node = node;
    while (cur.parent) {
        path.unshift(cur);
        cur = cur.parent;
    }
    path.unshift(start);
    return path;
}

function neighborIndexToHeading(i: number): Heading {
    return i === 0 ? HEADING_UP : i === 1 ? HEADING_RIGHT : i === 2 ? HEADING_DOWN : HEADING_LEFT;
}

function nodesEqual(a: Node, b: Node): boolean {
    return a.col === b.col && a.row === b.row;
}

// Excalidraw's estimateSegmentCount: the minimum remaining bends between two headed grid nodes, a 16-case
// lookup keyed on (endHeading, startHeading) and the relative endpoint positions.
function estimateSegmentCount(start: Node, end: Node, startHeading: Heading, endHeading: Heading): number {
    if (compareHeading(endHeading, HEADING_RIGHT)) {
        if (compareHeading(startHeading, HEADING_RIGHT)) {
            if (start.pos.x >= end.pos.x) return 4;
            if (start.pos.y === end.pos.y) return 0;
            return 2;
        }
        if (compareHeading(startHeading, HEADING_UP)) return start.pos.y > end.pos.y && start.pos.x < end.pos.x ? 1 : 3;
        if (compareHeading(startHeading, HEADING_DOWN))
            return start.pos.y < end.pos.y && start.pos.x < end.pos.x ? 1 : 3;
        if (compareHeading(startHeading, HEADING_LEFT)) return start.pos.y === end.pos.y ? 4 : 2;
    } else if (compareHeading(endHeading, HEADING_LEFT)) {
        if (compareHeading(startHeading, HEADING_RIGHT)) return start.pos.y === end.pos.y ? 4 : 2;
        if (compareHeading(startHeading, HEADING_UP)) return start.pos.y > end.pos.y && start.pos.x > end.pos.x ? 1 : 3;
        if (compareHeading(startHeading, HEADING_DOWN))
            return start.pos.y < end.pos.y && start.pos.x > end.pos.x ? 1 : 3;
        if (compareHeading(startHeading, HEADING_LEFT)) {
            if (start.pos.x <= end.pos.x) return 4;
            if (start.pos.y === end.pos.y) return 0;
            return 2;
        }
    } else if (compareHeading(endHeading, HEADING_UP)) {
        if (compareHeading(startHeading, HEADING_RIGHT))
            return start.pos.y > end.pos.y && start.pos.x < end.pos.x ? 1 : 3;
        if (compareHeading(startHeading, HEADING_UP)) {
            if (start.pos.y >= end.pos.y) return 4;
            if (start.pos.x === end.pos.x) return 0;
            return 2;
        }
        if (compareHeading(startHeading, HEADING_DOWN)) return start.pos.x === end.pos.x ? 4 : 2;
        if (compareHeading(startHeading, HEADING_LEFT))
            return start.pos.y > end.pos.y && start.pos.x > end.pos.x ? 1 : 3;
    } else if (compareHeading(endHeading, HEADING_DOWN)) {
        if (compareHeading(startHeading, HEADING_RIGHT))
            return start.pos.y < end.pos.y && start.pos.x < end.pos.x ? 1 : 3;
        if (compareHeading(startHeading, HEADING_UP)) return start.pos.x === end.pos.x ? 4 : 2;
        if (compareHeading(startHeading, HEADING_DOWN)) {
            if (start.pos.y <= end.pos.y) return 4;
            if (start.pos.x === end.pos.x) return 0;
            return 2;
        }
        if (compareHeading(startHeading, HEADING_LEFT))
            return start.pos.y < end.pos.y && start.pos.x > end.pos.x ? 1 : 3;
    }
    return 0;
}

// --- post-passes + fallback ------------------------------------------------------------

// Drop interior points within DEDUP_THRESHOLD px of their predecessor (only when ≥ 4 points).
function removeElbowArrowShortSegments(points: Point[]): Point[] {
    if (points.length < 4) return points;
    return points.filter((p, idx) => {
        if (idx === 0 || idx === points.length - 1) return true;
        return Math.hypot(p.x - points[idx - 1].x, p.y - points[idx - 1].y) > DEDUP_THRESHOLD;
    });
}

// Keep only direction changes, comparing by dominant axis (|dy| < |dx|) so ~1px slack still collapses —
// Excalidraw's getElbowArrowCornerPoints.
function getElbowArrowCornerPoints(points: Point[]): Point[] {
    if (points.length <= 1) return points;
    let previousHorizontal = Math.abs(points[0].y - points[1].y) < Math.abs(points[0].x - points[1].x);
    return points.filter((p, idx) => {
        if (idx === 0 || idx === points.length - 1) return true;
        const next = points[idx + 1];
        const nextHorizontal = Math.abs(p.y - next.y) < Math.abs(p.x - next.x);
        if (previousHorizontal === nextHorizontal) {
            previousHorizontal = nextHorizontal;
            return false;
        }
        previousHorizontal = nextHorizontal;
        return true;
    });
}

// Guaranteed-draw fallback when A* is walled in (Excalidraw returns null here and renders the raw update; we
// must always draw). A single right-angle turn between the endpoints, first segment along the start heading's
// axis. May cut through an obstacle — a drawn route beats none.
function lRoute(a: Point, b: Point, startHeading: Heading): Point[] {
    const corner = headingIsHorizontal(startHeading) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    return [a, corner, b];
}

// --- small helpers ---------------------------------------------------------------------

function manhattan(a: Point, b: Point): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function pointInside(p: Point, b: B4): boolean {
    return p.x > b[0] && p.x < b[2] && p.y > b[1] && p.y < b[3];
}

function crossXY(ax: number, ay: number, bx: number, by: number): number {
    return ax * by - bx * ay;
}
