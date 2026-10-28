// The pptx reader's arrows that come as paths: a bent or curved connector with a head, and an open freeform with one,
// which is how the pptx export writes an arrow of more than two points. Each becomes the arrow that draws it, so it
// keeps its arrowheads. Lines at right angles are an elbow arrow with every bend pinned, so the router never moves
// them, other lines a sharp arrow through their corners, and a curve a curved arrow through points along it. The shape
// reader calls connectorArrow and freeformArrow with the path the shape draws, after the flips.

import type {
    Arrowhead,
    Box,
    NewVectorElement,
    PathCommand,
    Point,
    Roundness,
    VectorArrowElement,
} from '@workspace/lib/vector';
import {
    arrowCurveBeziers,
    bezierAt,
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

// A freeform curve whose control points lie this close to those of the canvas's own curve through its ends draws as
// that curve, so it reads back as the arrow through those ends.
const OWN_CURVE_PX = 1;

type Stroke = Pick<VectorArrowElement, 'strokeColor' | 'strokeWidth' | 'strokeStyle'>;

// `path` is the preset's path in the unit box, `box` the shape's place on the slide.
export function connectorArrow(
    connector: Connector,
    path: string,
    box: Box,
    stroke: Stroke,
    ends: Arrowhead[],
): NewVectorElement {
    const polyline = polylineOf(parsePathCommands(path) ?? [], onSlide(box));
    return connector === 'bent'
        ? arrowThrough(corners(polyline), 'sharp', stroke, ends)
        : arrowThrough(polyline, 'round', stroke, ends);
}

// A freeform of one open subpath, of lines only or of curves only, as the pptx export writes an arrow. Undefined for
// any other, which stays a path: no arrow draws a closed shape, nor lines and curves at once.
export function freeformArrow(path: string, box: Box, stroke: Stroke, ends: Arrowhead[]): NewVectorElement | undefined {
    const commands = parsePathCommands(path) ?? [];
    const drawn = commands.slice(1);
    const curves = drawn.filter(({ op }) => op === 'C' || op === 'Q').length;
    const lines = drawn.filter(({ op }) => op === 'L').length;
    if (drawn.length === 0 || (curves !== drawn.length && lines !== drawn.length)) return undefined;
    const at = onSlide(box);
    const points = commands.map((command) => at(command.points[command.points.length - 1]));
    if (lines > 0) return arrowThrough(points, 'sharp', stroke, ends);
    const own = arrowCurveBeziers(points).every(([, c1, c2], i) => {
        const { op, points: controls } = drawn[i];
        return (
            op === 'C' && distance(c1, at(controls[0])) <= OWN_CURVE_PX && distance(c2, at(controls[1])) <= OWN_CURVE_PX
        );
    });
    return arrowThrough(own ? points : polylineOf(commands, at), 'round', stroke, ends);
}

// A point of the unit box on the slide.
function onSlide(box: Box): (p: Point) => Point {
    return (p) => linearLocalToScene(box, { x: p.x * box.width, y: p.y * box.height });
}

// The path's points on the slide, each curve cut into steps by the length of its control polygon.
function polylineOf(commands: PathCommand[], at: (p: Point) => Point): Point[] {
    const points: Point[] = [];
    for (const command of commands) {
        const controls = command.points.map(at);
        const from = points[points.length - 1];
        if (controls.length < 2 || !from) {
            points.push(...controls);
            continue;
        }
        const curve = [from, ...controls];
        const length = curve.slice(1).reduce((sum, p, i) => sum + distance(curve[i], p), 0);
        const steps = Math.min(MAX_STEPS_PER_CURVE, Math.max(2, Math.round(length / CURVE_STEP_PX)));
        for (let i = 1; i <= steps; i++) points.push(bezierAt(curve, i / steps));
    }
    return points;
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

// An elbow arrow pins only a leg between two others and draws only right angles, so lines of two legs, or any turned
// off a quarter turn, are a sharp arrow through their corners instead.
function arrowThrough(
    points: Point[],
    roundness: Roundness,
    { strokeColor, strokeWidth, strokeStyle }: Stroke,
    [startArrowhead, endArrowhead]: Arrowhead[],
): NewVectorElement {
    // The elbow's route is unturned, so every arrow stores its points on the slide, its box their box.
    const { minX, minY, maxX, maxY } = pointsBounds(points);
    const local = points.map((p) => ({ x: round(p.x - minX), y: round(p.y - minY) }));
    const elbow = roundness === 'sharp' && local.length >= 4 && validateElbowPoints(local);
    // Every leg between the first and the last pinned: a pin keys points[index - 1] to points[index].
    const fixedSegments = elbow
        ? serializeFixedSegments({
              segments: local.slice(2, -1).map((end, i) => ({
                  index: i + 2,
                  start: [local[i + 1].x, local[i + 1].y],
                  end: [end.x, end.y],
              })),
              startIsSpecial: false,
              endIsSpecial: false,
          })
        : '';
    return {
        type: 'arrow',
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        angle: 0,
        points: serializePoints(local),
        roundness,
        elbow,
        fixedSegments,
        startArrowhead,
        endArrowhead,
        strokeColor,
        strokeWidth,
        strokeStyle,
    };
}
