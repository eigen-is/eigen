import { clamp, round4 } from '@workspace/lib/vector';
import { A_NS, isOn } from '../../core/ooxml';
import { type XmlElement, xmlAttr, xmlElements } from '../../core/xml';
import { evaluateGuides, type GuideList, type Guides, guideListOf, guideValue } from './guides';
import { affords, charge, childOf } from './lookup';
import { emu } from './package';

// A shape's a:custGeom → what a canvas path element stores: absolute M/L/C/Q/Z in the shape's unit box, nonzero.

// The canvas reader's caps and coordinate range for a path (read-fields.ts and outline.ts own them once the path kind
// lands), so what the converter writes reads back unchanged.
export const MAX_PATH_BYTES = 16 * 1024;
export const MAX_PATH_COMMANDS = 512;
const PATH_COORD_MIN = -2;
const PATH_COORD_MAX = 3;

// The nodes of a custGeom's guide and path lists, its paths' and their commands' children, counted before any is read:
// the corpus's most is 4,636.
export const MAX_GEOMETRY_NODES = 32_768;

// Past the caps, a point within a tolerance of the line its neighbours draw goes, as does a curve that bulges no more:
// the least of these, in fractions of the box, that fits. The corpus's largest, a 2,222-point map outline, fits at the
// last, 2 px on its slide.
const SIMPLIFY_TOLERANCES = [0.001, 0.002, 0.004];
// Each split halves a run at best; past this depth a run keeps its points, so a pass costs 16 scans of them at most.
const MAX_SIMPLIFY_DEPTH = 16;

const DEGREE = 60_000;
const RADIANS_PER_UNIT = Math.PI / (180 * DEGREE);
const FULL_TURN = 360 * DEGREE;

// `filled` follows the path's fill flag: PowerPoint fills an unclosed subpath as if closed, as SVG does, so the element
// writer fills it, or leaves it open where the shape has no fill. `shade` is a PATH_SHADES value, for a shaded fill.
export type CustomGeometry = { path: string; closed: boolean; filled: boolean; stroked: boolean; shade?: number };

// A path's fill drawn as the shape's fill shaded, as LibreOffice draws it (EnhancedCustomShape2d.cxx): each sRGB channel
// blended toward white by a positive fraction, toward black by a negative one. ECMA-376 states no amounts.
export const PATH_SHADES: ReadonlyMap<string, number> = new Map([
    ['darken', -0.4],
    ['darkenLess', -0.2],
    ['lighten', 0.4],
    ['lightenLess', 0.2],
]);

type Point = { x: number; y: number };
type Segment = { op: 'L' | 'C' | 'Q'; points: Point[] };
type Subpath = { start: Point; segments: Segment[]; closed: boolean };

// One geometry for each way the paths paint, in the order they first draw, the paths painting alike concatenated; each
// becomes its own element at the shape's box. Undefined when nothing is drawn, or past a cap: the shape keeps its text.
// `width` and `height` are the shape's extents in EMU, its guides' w and h; `adjustments` a preset's, after its avLst.
export function customGeometry(
    custGeom: XmlElement,
    width: number,
    height: number,
    adjustments: GuideList = [],
): CustomGeometry[] | undefined {
    const [avLst, gdLst, pathLst] = ['avLst', 'gdLst', 'pathLst'].map((local) => childOf(custGeom, A_NS, local));
    const nodes = nodesOf([avLst, gdLst], pathLst);
    if (nodes === undefined || !affords(nodes)) return undefined;
    const guides = evaluateGuides(width, height, guideListOf(avLst), adjustments, guideListOf(gdLst));
    if (!guides) return undefined;
    const paths = pathLst ? xmlElements(pathLst).filter((path) => path.ns === A_NS && path.local === 'path') : [];
    charge(nodes - (avLst?.children.length ?? 0) - (gdLst?.children.length ?? 0));
    const painted = new Map<string, Omit<CustomGeometry, 'path' | 'closed'> & { subpaths: Subpath[] }>();
    for (const path of paths) {
        const fill = xmlAttr(path, '', 'fill');
        const filled = fill !== 'none';
        const shade = PATH_SHADES.get(fill ?? 'norm');
        const stroked = isOn(xmlAttr(path, '', 'stroke')) ?? true;
        if (!filled && !stroked) continue;
        const drawn = subpathsOf(path, guides, width, height);
        const subpaths = filled ? clockwise(drawn) : drawn;
        const key = `${filled} ${stroked} ${shade}`;
        const known = painted.get(key);
        if (known) known.subpaths.push(...subpaths);
        else painted.set(key, { filled, stroked, shade, subpaths });
    }
    const geometries: CustomGeometry[] = [];
    for (const { filled, stroked, shade, subpaths } of painted.values()) {
        if (subpaths.length === 0) continue;
        let path = fitted(subpaths);
        for (const tolerance of SIMPLIFY_TOLERANCES) {
            if (path !== undefined) break;
            path = fitted(subpaths.map((subpath) => simplified(subpath, tolerance)));
        }
        if (path === undefined) return undefined;
        const closed = subpaths.every((subpath) => subpath.closed);
        geometries.push(shade ? { path, closed, filled, stroked, shade } : { path, closed, filled, stroked });
    }
    return geometries.length > 0 ? geometries : undefined;
}

// Each count is read before the children it counts are walked.
function nodesOf(lists: (XmlElement | undefined)[], pathLst: XmlElement | undefined): number | undefined {
    let nodes =
        (pathLst?.children.length ?? 0) + lists.reduce((count, list) => count + (list?.children.length ?? 0), 0);
    if (nodes > MAX_GEOMETRY_NODES) return undefined;
    for (const path of pathLst ? xmlElements(pathLst) : []) {
        nodes += path.children.length;
        if (nodes > MAX_GEOMETRY_NODES) return undefined;
        for (const command of xmlElements(path)) nodes += command.children.length;
        if (nodes > MAX_GEOMETRY_NODES) return undefined;
    }
    return nodes;
}

// A path's w and h span the box; 0 or none spans the shape's EMU.
function subpathsOf(path: XmlElement, guides: Guides, width: number, height: number): Subpath[] {
    const span = (local: string, extent: number) => {
        const stated = emu(xmlAttr(path, '', local));
        return stated !== undefined && stated > 0 ? stated : extent;
    };
    const [w, h] = [span('w', width), span('h', height)];
    const boxed = (p: Point): Point => ({ x: inBox(p.x, w), y: inBox(p.y, h) });
    const value = (command: XmlElement, local: string) => guideValue(guides, xmlAttr(command, '', local));
    const subpaths: Subpath[] = [];
    let open: Subpath | undefined;
    // Where the pen is, and where its subpath began, in the path's own space.
    let pen: Point = { x: 0, y: 0 };
    let start = pen;
    const begin = (at: Point) => {
        open = { start: boxed(at), segments: [], closed: false };
        subpaths.push(open);
        [pen, start] = [at, at];
    };
    const draw = (op: Segment['op'], points: Point[]) => {
        if (!open || open.closed) begin(pen);
        open?.segments.push({ op, points: points.map(boxed) });
        pen = points[points.length - 1];
    };
    for (const command of xmlElements(path)) {
        if (command.ns !== A_NS) continue;
        const points = xmlElements(command)
            .filter((pt) => pt.ns === A_NS && pt.local === 'pt')
            .map((pt) => ({ x: value(pt, 'x'), y: value(pt, 'y') }));
        if (command.local === 'moveTo' && points.length >= 1) begin(points[0]);
        else if (command.local === 'lnTo' && points.length >= 1) draw('L', points.slice(0, 1));
        else if (command.local === 'cubicBezTo' && points.length >= 3) draw('C', points.slice(0, 3));
        else if (command.local === 'quadBezTo' && points.length >= 2) draw('Q', points.slice(0, 2));
        else if (command.local === 'arcTo') {
            const radii = { x: value(command, 'wR'), y: value(command, 'hR') };
            for (const curve of arcCurves(pen, radii, value(command, 'stAng'), value(command, 'swAng')))
                draw('C', curve);
        } else if (command.local === 'close' && open && !open.closed && open.segments.length > 0) {
            open.closed = true;
            pen = start;
        }
    }
    return subpaths.filter((subpath) => subpath.segments.length > 0);
}

// PowerPoint fills each path on its own, so paths concatenated must fill as their union, which nonzero gives only where
// each winds the same way: a filled path winding anticlockwise overall (its points' shoelace sum, controls included) is
// reversed. A firewall's bricks, drawn the other way round from the wall behind them, would otherwise be holes in it.
function clockwise(subpaths: Subpath[]): Subpath[] {
    let area = 0;
    for (const { start, segments } of subpaths) {
        let previous = start;
        for (const point of [...segments.flatMap((segment) => segment.points), start]) {
            area += previous.x * point.y - point.x * previous.y;
            previous = point;
        }
    }
    return area < 0 ? subpaths.map(reversed) : subpaths;
}

function reversed({ start, segments, closed }: Subpath): Subpath {
    const ends = [start, ...segments.map((segment) => segment.points[segment.points.length - 1])];
    return {
        start: ends[ends.length - 1],
        segments: segments
            .map(({ op, points }, i) => ({ op, points: [...points.slice(0, -1).reverse(), ends[i]] }))
            .reverse(),
        closed,
    };
}

// A box of no extent puts every point at its edge; NaN, from infinities cancelling, at 0.
function inBox(value: number, extent: number): number {
    const unit = extent > 0 ? value / extent : 0;
    return Number.isNaN(unit) ? 0 : round4(clamp(unit, PATH_COORD_MIN, PATH_COORD_MAX));
}

// arcTo's angles are on the ellipse as drawn, so each maps to the parametric angle that reaches it, keeping its turns. A
// sweep past a full turn retraces it, so it stops at one: four quarters at most.
function arcCurves(from: Point, radii: Point, startAngle: number, sweepAngle: number): Point[][] {
    const start = (startAngle % FULL_TURN) * RADIANS_PER_UNIT;
    const sweep = clamp(sweepAngle, -FULL_TURN, FULL_TURN) * RADIANS_PER_UNIT;
    const parametric = (visual: number) => {
        const turns = Math.round((visual - Math.atan2(Math.sin(visual), Math.cos(visual))) / (2 * Math.PI));
        return Math.atan2(radii.x * Math.sin(visual), radii.y * Math.cos(visual)) + turns * 2 * Math.PI;
    };
    const [first, last] = [parametric(start), parametric(start + sweep)];
    const centre = { x: from.x - radii.x * Math.cos(first), y: from.y - radii.y * Math.sin(first) };
    const on = (t: number) => ({ x: centre.x + radii.x * Math.cos(t), y: centre.y + radii.y * Math.sin(t) });
    const tangent = (t: number, k: number) => ({ x: -k * radii.x * Math.sin(t), y: k * radii.y * Math.cos(t) });
    const count = Math.ceil(Math.abs(last - first) / (Math.PI / 2) - 1e-9);
    const step = (last - first) / count;
    // A quarter or less of an ellipse as one cubic: its control points 4/3·tan(θ/4) along the tangents.
    const k = (4 / 3) * Math.tan(step / 4);
    const curves: Point[][] = [];
    let p0 = from;
    for (let i = 1; i <= count; i++) {
        const [a, b] = [first + (i - 1) * step, first + i * step];
        const p3 = on(b);
        const [t0, t3] = [tangent(a, k), tangent(b, k)];
        curves.push([{ x: p0.x + t0.x, y: p0.y + t0.y }, { x: p3.x - t3.x, y: p3.y - t3.y }, p3]);
        p0 = p3;
    }
    return curves;
}

// The canonical spelling the canvas reader keeps, or undefined past its caps.
function fitted(subpaths: Subpath[]): string | undefined {
    let commands = 0;
    const parts: string[] = [];
    for (const { start, segments, closed } of subpaths) {
        commands += 1 + segments.length + (closed ? 1 : 0);
        parts.push(`M ${start.x} ${start.y}`);
        for (const { op, points } of segments) parts.push(`${op} ${points.map(({ x, y }) => `${x} ${y}`).join(' ')}`);
        if (closed) parts.push('Z');
    }
    const path = parts.join(' ');
    return commands <= MAX_PATH_COMMANDS && path.length <= MAX_PATH_BYTES ? path : undefined;
}

// A curve that bulges less than the tolerance is its chord; each run of lines keeps only the points that turn it more,
// and a closed subpath's last line back to its start is the close's.
function simplified(subpath: Subpath, tolerance: number): Subpath {
    const segments: Segment[] = [];
    let run: Point[] = [subpath.start];
    const flush = () => {
        for (const point of reduced(run, tolerance).slice(1)) segments.push({ op: 'L', points: [point] });
    };
    for (const segment of subpath.segments) {
        const end = segment.points[segment.points.length - 1];
        const from = run[run.length - 1];
        if (segment.op === 'L' || segment.points.every((p) => distance(p, from, end) <= tolerance)) {
            run.push(end);
            continue;
        }
        flush();
        segments.push(segment);
        run = [end];
    }
    flush();
    const last = segments[segments.length - 1];
    const closing = subpath.closed && last.op === 'L' && segments.length > 1;
    if (closing && last.points[0].x === subpath.start.x && last.points[0].y === subpath.start.y) segments.pop();
    return { ...subpath, segments };
}

// Ramer–Douglas–Peucker over a run's points, its ends kept.
function reduced(points: Point[], tolerance: number): Point[] {
    const last = points.length - 1;
    if (last < 2) return points;
    const kept = points.map((_, i) => i === 0 || i === last);
    const spans: [from: number, to: number, depth: number][] = [[0, last, 0]];
    for (let span = spans.pop(); span; span = spans.pop()) {
        const [from, to, depth] = span;
        let farthest = -1;
        let most = tolerance;
        for (let i = from + 1; i < to; i++) {
            const d = distance(points[i], points[from], points[to]);
            if (d > most) [farthest, most] = [i, d];
        }
        if (farthest < 0) continue;
        if (depth >= MAX_SIMPLIFY_DEPTH) kept.fill(true, from, to);
        else {
            kept[farthest] = true;
            spans.push([from, farthest, depth + 1], [farthest, to, depth + 1]);
        }
    }
    return points.filter((_, i) => kept[i]);
}

// From p to the segment a–b.
function distance(p: Point, a: Point, b: Point): number {
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    const length = dx * dx + dy * dy;
    const t = length > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
