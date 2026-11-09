// Routes an elbow arrow, as a port of Excalidraw's router. The right-angled path is derived from the two endpoints
// and their bindings on every read, so the server's renderers draw what the canvas draws. The router grows an
// obstacle box around each bound shape, lays a grid along the box edges and runs A* over it. When A* finds no
// route it falls back to a single right-angle turn. `arrowRoute` is the entry point, called for example by the SVG
// renderer, the pptx writer and the canvas.

import { boundShape, elementBounds } from './binding';
import type { B4 } from './elbow-heading';
import { aabbForElement, distanceToElement, getHeadingForElbowArrowSnap } from './elbow-heading';
import type { PinRoutingContext } from './elbow-pins';
import type { Bounds, Point } from './geometry';
import { linearLocalToScene, linearSceneToLocal, unionBounds } from './geometry';
import type { Heading } from './heading';
import {
    BASE_BINDING_GAP_ELBOW,
    BASE_PADDING,
    compareHeading,
    DEDUP_THRESHOLD,
    flipHeading,
    HEADING_DOWN,
    HEADING_LEFT,
    HEADING_RIGHT,
    HEADING_UP,
    headingIsHorizontal,
    headingIsHorizontalVec,
    vectorToHeading,
} from './heading';
import { parsePoints } from './points';
import type { VectorArrowElement, VectorBindableElement, VectorElement } from './types';

// The polyline an arrow draws and hits as. A straight arrow has none, so it returns undefined. Every render path
// asks here, so none of them can draw an elbow arrow as a straight line by mistake. Without `byId` there are no
// bound shapes to route around, so it returns undefined and the caller falls back to the stored points.
export function arrowRoute(el: VectorElement, byId?: Map<string, VectorElement>): Point[] | undefined {
    if (el.type !== 'arrow' || !el.elbow) return undefined;
    // A pinned arrow's stored polyline is its route, and the pin editors keep it up to date. Every render path
    // returns it as it is, so a preview and the commit draw the same path.
    if (el.fixedSegments !== '') return parsePoints(el.points);
    return byId ? elbowRoute(el, byId) : undefined;
}

// The derived route of an elbow arrow without pins, in the arrow's local frame. It always starts exactly at the
// first stored point and ends exactly at the last, because the endpoint dot is drawn there and the shaft must meet
// it. Excalidraw keeps its stored points in step with the dock. Here boundEndpoint writes the dock into the stored
// points, so the router only reads them. The only obstacles are the bound shapes. An arrow with fewer than two
// points comes back as it is.
function elbowRoute(arrow: VectorArrowElement, byId: Map<string, VectorElement>): Point[] {
    const pts = parsePoints(arrow.points);
    if (pts.length < 2) return pts;

    const startGlobal = linearLocalToScene(arrow, pts[0]);
    const endGlobal = linearLocalToScene(arrow, pts[pts.length - 1]);
    const data = getElbowArrowData(
        {
            startShape: boundShape(arrow.startBinding, byId),
            endShape: boundShape(arrow.endBinding, byId),
            startGlobal,
            endGlobal,
            startArrowhead: arrow.startArrowhead !== 'none',
            endArrowhead: arrow.endArrowhead !== 'none',
        },
        !!arrow.startBinding,
    );
    const routeScene = routeElbowArrow(data) ?? lRoute(startGlobal, endGlobal, data.startHeading);

    const corners = getElbowArrowCornerPoints(removeElbowArrowShortSegments(routeScene));
    const local = corners.map((p) => linearSceneToLocal(arrow, p));
    return local.length >= 2 ? local : [linearSceneToLocal(arrow, startGlobal), linearSceneToLocal(arrow, endGlobal)];
}

// The union of every element's bounds, with arrow labels and elbow bends included. `elements` must not be empty.
export function sceneBounds(elements: VectorElement[], byId: Map<string, VectorElement>): Bounds {
    return elements.map((el) => elementBounds(el, arrowRoute(el, byId))).reduce(unionBounds);
}

// What a pin jog on an end segment needs to know: which ends are bound, and the axis and direction of each end's
// heading. It is computed here, so the pin code needs no scene. It uses the stored endpoints, as at rest.
export function elbowRoutingContext(arrow: VectorArrowElement, byId: Map<string, VectorElement>): PinRoutingContext {
    const startShape = boundShape(arrow.startBinding, byId);
    const endShape = boundShape(arrow.endBinding, byId);
    const pts = parsePoints(arrow.points);
    const startGlobal = linearLocalToScene(arrow, pts[0]);
    const endGlobal = linearLocalToScene(arrow, pts[pts.length - 1]);
    const { startHeading, endHeading } = endpointHeadings(startShape, endShape, startGlobal, endGlobal);
    const positive = (h: Heading): boolean =>
        headingIsHorizontal(h) ? compareHeading(h, HEADING_RIGHT) : compareHeading(h, HEADING_DOWN);
    return {
        startBound: !!startShape,
        endBound: !!endShape,
        startHeadingHorizontal: headingIsHorizontal(startHeading),
        startHeadingPositive: positive(startHeading),
        endHeadingHorizontal: headingIsHorizontal(endHeading),
        endHeadingPositive: positive(endHeading),
    };
}

type RouteInputs = {
    startShape: VectorBindableElement | null;
    endShape: VectorBindableElement | null;
    startGlobal: Point;
    endGlobal: Point;
    startArrowhead: boolean;
    endArrowhead: boolean;
};

// A dongle is where the route leaves an end's obstacle box: the endpoint moved along its heading onto the edge of
// that box. A* runs from dongle to dongle.
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

// The headings, obstacle boxes and dongles of one route, as the at-rest branch of Excalidraw's getElbowArrowData.
function getElbowArrowData(input: RouteInputs, startBinding: boolean): ElbowArrowData {
    const { startShape, endShape, startGlobal, endGlobal, startArrowhead, endArrowhead } = input;

    const { startHeading, endHeading } = endpointHeadings(startShape, endShape, startGlobal, endGlobal);

    const startPointBounds = pointBounds(startGlobal);
    const endPointBounds = pointBounds(endGlobal);

    // A bound end's obstacle is its shape's box, pushed out far on the side the arrow leaves by and by 1 on the
    // other sides. An unbound end only has a small box around its point.
    const startElementBounds = startShape
        ? aabbForElement(startShape, offsetFromHeading(startHeading, headGap(startShape, startArrowhead), 1))
        : startPointBounds;
    const endElementBounds = endShape
        ? aabbForElement(endShape, offsetFromHeading(endHeading, headGap(endShape, endArrowhead), 1))
        : endPointBounds;

    // When an endpoint sits inside the other end's padded box, the shapes overlap. Both obstacles then shrink to
    // their point boxes, so a route between them still exists.
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

// The heading each end leaves by, as the heading part of Excalidraw's getElbowArrowData. For a bound end, the cone
// box is its shape grown on every side by the endpoint's distance to the outline. An unbound end points at the other
// end. The router and elbowRoutingContext both read their headings here.
function endpointHeadings(
    startShape: VectorBindableElement | null,
    endShape: VectorBindableElement | null,
    startGlobal: Point,
    endGlobal: Point,
): { startHeading: Heading; endHeading: Heading } {
    const startConeAABB = startShape
        ? aabbForElement(startShape, fill4(distanceToElement(startShape, startGlobal)))
        : null;
    const endConeAABB = endShape ? aabbForElement(endShape, fill4(distanceToElement(endShape, endGlobal))) : null;
    return {
        startHeading: getHeadingForElbowArrowSnap(startGlobal, endGlobal, startShape, startConeAABB),
        endHeading: getHeadingForElbowArrowSnap(endGlobal, startGlobal, endShape, endConeAABB),
    };
}

// How far an obstacle reaches past its shape on the side the arrow leaves by, as Excalidraw's getBindingGap times
// six with an arrowhead and two without. The gap grows with the stroke width.
function headGap(shape: VectorBindableElement, hasArrowhead: boolean): number {
    return (BASE_BINDING_GAP_ELBOW + shape.strokeWidth / 2) * (hasArrowhead ? 6 : 2);
}

function pointBounds(p: Point): B4 {
    return [p.x - 2, p.y - 2, p.x + 2, p.y + 2];
}

function fill4(v: number): B4 {
    return [v, v, v, v];
}

// Assembles the route, as Excalidraw's routeElbowArrow. A* runs between the dongles, and the endpoints are added
// back at both ends. It returns null when A* finds no way through.
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

    // A bound end's endpoint touches its shape, so A* may not step onto it. The start checks the stored binding and
    // the end checks the shape that was found, as Excalidraw does.
    const endNode = pointToGridNode(endGlobal, grid);
    if (endNode && endBound) endNode.closed = true;
    const startNode = pointToGridNode(startGlobal, grid);
    if (startNode && startBound) startNode.closed = true;

    const start = startDongleNode ?? startNode;
    const end = endDongleNode ?? endNode;
    if (!start || !end) return null;

    // When a dongle sits inside the other end's box, the boxes would wall it in, so A* runs without obstacles.
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

// Excalidraw's offsetFromHeading. It puts `head` on the side the heading points to and `side` on the other three,
// in the [top, right, down, left] order that aabbForElement takes.
function offsetFromHeading(heading: Heading, head: number, side: number): B4 {
    if (compareHeading(heading, HEADING_UP)) return [head, side, side, side];
    if (compareHeading(heading, HEADING_RIGHT)) return [side, head, side, side];
    if (compareHeading(heading, HEADING_DOWN)) return [side, side, head, side];
    return [side, side, side, head];
}

// The two obstacle boxes, ported as they are from Excalidraw's generateDynamicAABBs, nested ternaries included.
// Each box grows toward the other only as far as the line halfway between the two shapes, so the boxes touch but
// don't overlap. The two difference tuples pad each box per side. When the padded boxes still overlap on both
// axes, they sit diagonally to each other, and both are cut at the line between them. `disableSideHack` turns that
// cut off, which the caller does when the shapes overlap.
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
            // The start box is below and to the left of the end box.
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
            // The start box is above and to the left of the end box.
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
            // The start box is above and to the right of the end box.
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
            // The start box is below and to the right of the end box.
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

// The grid A* walks, as Excalidraw's calculateGrid. Its lines run along every obstacle edge and the common bounds,
// so the spacing is not even. Each dongle adds one line along the axis it leaves by, because its other coordinate
// already lies on a box edge.
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

// The dongle of an end: its endpoint moved along its heading onto the edge of its obstacle box.
function getDonglePosition(bounds: B4, heading: Heading, p: Point): Point {
    if (compareHeading(heading, HEADING_UP)) return { x: p.x, y: bounds[1] };
    if (compareHeading(heading, HEADING_RIGHT)) return { x: bounds[2], y: p.y };
    if (compareHeading(heading, HEADING_DOWN)) return { x: p.x, y: bounds[3] };
    return { x: bounds[0], y: p.y };
}

// A min-heap on `f`, as Excalidraw's BinaryHeap. Its method names are kept: sinkDown moves a node up toward the
// root, and bubbleUp moves it down.
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

    public push(node: Node): void {
        this.content.push(node);
        this.sinkDown(this.content.length - 1);
    }

    public pop(): Node | null {
        if (this.content.length === 0) return null;
        const result = this.content[0];
        const end = this.content.pop();
        if (end && this.content.length > 0) {
            this.content[0] = end;
            this.bubbleUp(0);
        }
        return result;
    }

    public size(): number {
        return this.content.length;
    }

    public rescore(node: Node): void {
        this.sinkDown(this.content.indexOf(node));
    }
}

// A* over the grid from dongle to dongle, as Excalidraw's astar. Each step costs its length. A bend adds the cube of
// the distance between the dongles, so the search prefers fewer bends over a shorter path at any scale. The
// heuristic adds the remaining distance and the estimated bends left, times the square of that distance. A step
// whose midpoint lies inside an obstacle is not allowed, and neither is a step that turns back. A step onto the
// start or end node along that end's own heading is not allowed either, because it would arrive from the shape's
// side. Neighbors are tried up, right, down, left, which settles ties the way Excalidraw does.
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

// Excalidraw's estimateSegmentCount. It looks up the fewest bends a route still needs between two nodes, from the
// heading at each and from where the two lie relative to each other.
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

// Excalidraw's removeElbowArrowShortSegments. It drops an inner point closer than DEDUP_THRESHOLD to the point
// before it. A route of fewer than four points stays as it is.
function removeElbowArrowShortSegments(points: Point[]): Point[] {
    if (points.length < 4) return points;
    return points.filter((p, idx) => {
        if (idx === 0 || idx === points.length - 1) return true;
        return Math.hypot(p.x - points[idx - 1].x, p.y - points[idx - 1].y) > DEDUP_THRESHOLD;
    });
}

// Keeps only the points where the route turns, as Excalidraw's getElbowArrowCornerPoints. A segment counts as
// horizontal or vertical by its longer axis, so a segment a pixel off true still merges with its neighbor.
function getElbowArrowCornerPoints(points: Point[]): Point[] {
    if (points.length <= 1) return points;
    let previousHorizontal = headingIsHorizontalVec(points[0], points[1]);
    return points.filter((p, idx) => {
        if (idx === 0 || idx === points.length - 1) return true;
        const next = points[idx + 1];
        const nextHorizontal = headingIsHorizontalVec(p, next);
        if (previousHorizontal === nextHorizontal) {
            previousHorizontal = nextHorizontal;
            return false;
        }
        previousHorizontal = nextHorizontal;
        return true;
    });
}

// The fallback when A* finds no way through. Excalidraw then draws the raw points, but this router must always
// return a route. It makes one right-angle turn between the endpoints, and the first segment runs along the axis
// of the start heading. It may cut through an obstacle, because an arrow through a shape beats no arrow.
function lRoute(a: Point, b: Point, startHeading: Heading): Point[] {
    const corner = headingIsHorizontal(startHeading) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    return [a, corner, b];
}

function manhattan(a: Point, b: Point): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function pointInside(p: Point, b: B4): boolean {
    return p.x > b[0] && p.x < b[2] && p.y > b[1] && p.y < b[3];
}

function crossXY(ax: number, ay: number, bx: number, by: number): number {
    return ax * by - bx * ay;
}
