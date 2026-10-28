// The pptx reader's bent and curved connectors, as the arrow that draws each, so a connector keeps its arrowheads. A
// bent connector is an elbow arrow with every bend pinned, so the router never moves them. A curved one is a curved
// arrow through points along its curve. The shape reader calls connectorArrow with the path the connector's preset
// draws, after the flips.

import type { Arrowhead, Box, NewVectorElement, PathCommand, Point, VectorArrowElement } from '@workspace/lib/vector';
import {
    distance,
    linearLocalToScene,
    parsePathCommands,
    pointsBounds,
    round,
    serializeFixedSegments,
    serializePoints,
    validateElbowPoints,
} from '@workspace/lib/vector';

type Connector = 'bent' | 'curved';

export const CONNECTORS: ReadonlyMap<string, Connector> = new Map([
    ['bentConnector2', 'bent'],
    ['bentConnector3', 'bent'],
    ['bentConnector4', 'bent'],
    ['bentConnector5', 'bent'],
    ['curvedConnector2', 'curved'],
    ['curvedConnector3', 'curved'],
    ['curvedConnector4', 'curved'],
    ['curvedConnector5', 'curved'],
]);

// A curve gets a point about every 40 px, so its last chord, which a head points along, is long enough for a whole
// head. The canvas's curve through them stays within about a pixel of PowerPoint's. The cap bounds a hostile extent.
const CURVE_STEP_PX = 40;
const MAX_STEPS_PER_CURVE = 8;

type Stroke = Pick<VectorArrowElement, 'strokeColor' | 'strokeWidth' | 'strokeStyle'>;

// `path` is the preset's path in the unit box, `box` the shape's place on the slide. An elbow arrow pins only a leg
// between two others and draws only right angles, so a connector of two legs, or one turned off a quarter turn, is a
// sharp arrow through its corners instead.
export function connectorArrow(
    connector: Connector,
    path: string,
    box: Box,
    { strokeColor, strokeWidth, strokeStyle }: Stroke,
    [startArrowhead, endArrowhead]: Arrowhead[],
): NewVectorElement {
    const onSlide = (p: Point) => linearLocalToScene(box, { x: p.x * box.width, y: p.y * box.height });
    const polyline = polylineOf(parsePathCommands(path) ?? [], onSlide);
    const points = connector === 'bent' ? corners(polyline) : polyline;
    // The elbow's route is unturned, so every arrow stores its points on the slide, its box their box.
    const { minX, minY, maxX, maxY } = pointsBounds(points);
    const local = points.map((p) => ({ x: round(p.x - minX), y: round(p.y - minY) }));
    const elbow = connector === 'bent' && local.length >= 4 && validateElbowPoints(local);
    return {
        type: 'arrow',
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        angle: 0,
        points: serializePoints(local),
        roundness: connector === 'curved' ? 'round' : 'sharp',
        elbow,
        fixedSegments: elbow ? pinnedBends(local) : '',
        startArrowhead,
        endArrowhead,
        strokeColor,
        strokeWidth,
        strokeStyle,
    };
}

// The path's points on the slide, each cubic cut into steps by the length of its control polygon.
function polylineOf(commands: PathCommand[], onSlide: (p: Point) => Point): Point[] {
    const points: Point[] = [];
    for (const { op, points: controls } of commands) {
        const ends = controls.map(onSlide);
        const from = points[points.length - 1];
        if (op !== 'C' || !from) {
            points.push(...ends);
            continue;
        }
        const [c1, c2, to] = ends;
        const length = distance(from, c1) + distance(c1, c2) + distance(c2, to);
        const steps = Math.min(MAX_STEPS_PER_CURVE, Math.max(2, Math.round(length / CURVE_STEP_PX)));
        for (let i = 1; i <= steps; i++) points.push(cubicAt([from, c1, c2, to], i / steps));
    }
    return points;
}

function cubicAt([p0, p1, p2, p3]: Point[], t: number): Point {
    const weights = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
    return {
        x: weights[0] * p0.x + weights[1] * p1.x + weights[2] * p2.x + weights[3] * p3.x,
        y: weights[0] * p0.y + weights[1] * p1.y + weights[2] * p2.y + weights[3] * p3.y,
    };
}

// A bent connector's adjust values can make two bends meet or a leg go straight on. Such a point is no corner, and a
// leg of no length would point a head nowhere.
function corners(points: Point[]): Point[] {
    const kept: Point[] = [];
    for (const point of points) {
        const [before, last] = [kept[kept.length - 2], kept[kept.length - 1]];
        const merges = last && (distance(last, point) < 1 || (before && straightOn(before, last, point)));
        if (merges) kept[kept.length - 1] = point;
        else kept.push(point);
    }
    return kept;
}

function straightOn(a: Point, b: Point, c: Point): boolean {
    const [u, v] = [
        { x: b.x - a.x, y: b.y - a.y },
        { x: c.x - b.x, y: c.y - b.y },
    ];
    const cross = u.x * v.y - u.y * v.x;
    return Math.abs(cross) <= 1e-6 * Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) && u.x * v.x + u.y * v.y > 0;
}

// Every leg between the first and the last pinned: a pin keys points[index - 1] to points[index].
function pinnedBends(points: Point[]): string {
    return serializeFixedSegments({
        segments: points.slice(2, -1).map((end, i) => ({
            index: i + 2,
            start: [points[i + 1].x, points[i + 1].y],
            end: [end.x, end.y],
        })),
        startIsSpecial: false,
        endIsSpecial: false,
    });
}
