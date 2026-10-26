// Turns a shape's DrawingML geometry into what a canvas path element stores: absolute M/L/C/Q/Z in the shape's unit
// box, filled nonzero. It winds each subpath by how deep it nests, so a contour inside another is a hole, concatenates
// the paths that paint alike, and simplifies a path past the canvas's caps. A custGeom comes through it, and so does
// every preset the preset reader expands.

import {
    clamp,
    MAX_PATH_BYTES,
    MAX_PATH_COMMANDS,
    PATH_COORD_MAX,
    PATH_COORD_MIN,
    round4,
} from '@workspace/lib/vector';
import type { XmlElement } from '../../core/xml';
import { xmlAttr, xmlElements } from '../../core/xml';
import { DEGREE } from '../../ooxml/drawingml';
import { A_NS, emu, isOn } from '../../ooxml/ooxml';
import type { GuideList, Guides } from './guides';
import { evaluateGuides, guideListOf, guideValue, RADIANS_PER_UNIT } from './guides';
import { affords, charge, childOf, spend } from './lookup';

// The nodes of a custGeom's guide and path lists, its paths' and their commands' children, counted before any is read:
// the corpus's most is 4,636.
export const MAX_GEOMETRY_NODES = 32_768;

// A subpath is a move and a segment at least, so a filled path of more can never fit: its nesting is never worked out.
const MAX_SUBPATHS = MAX_PATH_COMMANDS / 2;

// Paths painting alike concatenate only while their boxes overlap none of the others': the canvas fills nonzero, but the
// pptx export writes the element as one a:path, which LibreOffice fills even-odd, so an overlap would come back a hole.
// A shape is this many geometries at most, so twice as many elements, a filled open one's fill and line apart: past it
// an alike path concatenates overlapping or not, and one painting a new way leaves the shape undrawn.
export const MAX_SHAPE_PATHS = 32;

// A curve's outline is its chords, as many as Wang's formula says keep within this fraction of the box of it, so a
// contour that close inside another still nests: ends and middles alone make an octagon 7.6% inside a circle.
const OUTLINE_TOLERANCE = 0.001;
const MAX_CURVE_CHORDS = 16;

// Past the caps, a point within a tolerance of the line its neighbours draw goes, as does a curve that bulges no more:
// the least of these, in fractions of the box, that fits. The corpus's largest, a 2,222-point map outline, fits at the
// last, 2 px on its slide.
const SIMPLIFY_TOLERANCES = [0.001, 0.002, 0.004];
// Each split halves a run at best; past this depth a run keeps its points, so a pass costs 16 scans of them at most.
const MAX_SIMPLIFY_DEPTH = 16;

const FULL_TURN = 360 * DEGREE;

// `filled` follows the path's fill flag: PowerPoint fills an unclosed subpath as if closed, as SVG does, so the element
// writer fills closedPath(path) and strokes the path as drawn; a filled path leaves room for those closes. `shade` is a
// PATH_SHADES value, for a shaded fill.
export type GeometryPath = { path: string; closed: boolean; filled: boolean; stroked: boolean; shade?: number };

// A path's fill drawn as the shape's fill shaded, as LibreOffice draws it (EnhancedCustomShape2d.cxx): each sRGB channel
// blended toward white by a positive fraction, toward black by a negative one. ECMA-376 states no amounts.
const PATH_SHADES: ReadonlyMap<string, number> = new Map([
    ['darken', -0.4],
    ['darkenLess', -0.2],
    ['lighten', 0.4],
    ['lightenLess', 0.2],
]);

type Point = { x: number; y: number };
type Segment = { op: 'L' | 'C' | 'Q'; points: Point[] };
type Subpath = { start: Point; segments: Segment[]; closed: boolean };

type Painted = Omit<GeometryPath, 'path' | 'closed'> & { subpaths: Subpath[]; boxes: Bounds[] };

// One geometry for each way the paths paint, the paths painting alike and apart concatenated, in the order they first
// draw but the filled before the lines, as LibreOffice and Apache POI stroke over every fill; each becomes its own element
// at the shape's box. Undefined when nothing is drawn, or past a cap or the read's budget: the shape keeps its text.
// `width` and `height` are the shape's extents in EMU, its guides' w and h; `mirrored` flips it across its box, as
// DrawingML flips a shape before it turns it; `adjustments` are a preset's, after its avLst.
export function customGeometry(
    custGeom: XmlElement,
    width: number,
    height: number,
    mirrored = false,
    adjustments: GuideList = [],
): GeometryPath[] | undefined {
    const [avLst, gdLst, pathLst] = ['avLst', 'gdLst', 'pathLst'].map((local) => childOf(custGeom, A_NS, local));
    const nodes = nodesOf([avLst, gdLst], pathLst);
    if (nodes === undefined || !affords(nodes)) return undefined;
    const guides = evaluateGuides(width, height, guideListOf(avLst), adjustments, guideListOf(gdLst));
    if (!guides) return undefined;
    const paths = pathLst ? xmlElements(pathLst).filter((path) => path.ns === A_NS && path.local === 'path') : [];
    charge(nodes - (avLst?.children.length ?? 0) - (gdLst?.children.length ?? 0));
    const painted: Painted[] = [];
    const lastPainted = new Map<string, Painted>();
    for (const path of paths) {
        const fill = xmlAttr(path, '', 'fill');
        const filled = fill !== 'none';
        const shade = PATH_SHADES.get(fill ?? 'norm');
        const stroked = isOn(xmlAttr(path, '', 'stroke')) ?? true;
        if (!filled && !stroked) continue;
        const drawn = subpathsOf(path, guides, { width, height, mirrored });
        if (!drawn || (filled && drawn.length > MAX_SUBPATHS)) return undefined;
        if (drawn.length === 0) continue;
        const subpaths = filled ? windByNesting(drawn) : drawn;
        if (!subpaths) return undefined;
        const box = boundsOf(subpaths.flatMap(pointsOf));
        const key = `${filled} ${stroked} ${shade}`;
        const last = lastPainted.get(key);
        const full = painted.length >= MAX_SHAPE_PATHS;
        // Its box against each of the alike geometry's it may join.
        if (filled && last && !full && !spend(last.boxes.length)) return undefined;
        if (last && (!filled || full || !last.boxes.some((other) => overlap(box, other)))) {
            last.subpaths.push(...subpaths);
            last.boxes.push(box);
        } else if (full) return undefined;
        else {
            const started = { filled, stroked, shade, subpaths, boxes: [box] };
            painted.push(started);
            lastPainted.set(key, started);
        }
    }
    const geometries: GeometryPath[] = [];
    for (const { filled, stroked, shade, subpaths } of painted) {
        let path = pathWithinCaps(subpaths, filled);
        const segments = subpaths.reduce((count, subpath) => count + subpath.segments.length, 0);
        for (const tolerance of SIMPLIFY_TOLERANCES) {
            if (path !== undefined) break;
            // The pass's own scan of the segments, then reduced's of each run's points at each depth it splits to.
            if (!affords(segments * (MAX_SIMPLIFY_DEPTH + 2))) return undefined;
            charge(segments);
            path = pathWithinCaps(
                subpaths.map((subpath) => simplified(subpath, tolerance)),
                filled,
            );
        }
        if (path === undefined) return undefined;
        const closed = subpaths.every((subpath) => subpath.closed);
        geometries.push(shade ? { path, closed, filled, stroked, shade } : { path, closed, filled, stroked });
    }
    return geometries.length > 0 ? geometries.sort((a, b) => Number(b.filled) - Number(a.filled)) : undefined;
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

// A path's w and h span the box; 0 or none spans the shape's EMU. Mirrored here, so the caps measure the path stored.
// Undefined where the read's budget can't cover its arcs.
function subpathsOf(
    path: XmlElement,
    guides: Guides,
    { width, height, mirrored }: { width: number; height: number; mirrored: boolean },
): Subpath[] | undefined {
    const span = (local: string, extent: number) => {
        const stated = emu(xmlAttr(path, '', local));
        return stated !== undefined && stated > 0 ? stated : extent;
    };
    const [w, h] = [span('w', width), span('h', height)];
    const boxed = (p: Point): Point => {
        const x = inBox(p.x, w);
        return { x: mirrored ? round4(1 - x) : x, y: inBox(p.y, h) };
    };
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
    const commands = xmlElements(path);
    // One node, but up to four curves each pass scans.
    if (!spend(4 * commands.filter((command) => command.local === 'arcTo').length)) return undefined;
    for (const command of commands) {
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

// PowerPoint fills each path on its own and LibreOffice even-odd, while the canvas fills nonzero: each subpath winds by
// how deep it lies among its path's others, the outermost clockwise, a hole in one the other way, an island in that
// clockwise again. A contour inside another of its path is then a hole however the file wound it, and roughjs's even-odd
// hatch agrees. Undefined where the read's budget can't cover the work, before it begins.
function windByNesting(subpaths: Subpath[]): Subpath[] | undefined {
    // Each subpath's probe against each other's bounds; then the outlines and the tests the probes take, before either.
    if (!spend(subpaths.length * (subpaths.length - 1))) return undefined;
    const bounds = subpaths.map((subpath) => boundsOf(pointsOf(subpath)));
    // The middle of the first segment, on the curve, where a chord's middle would lie inside it: as far inside the
    // contour around as the subpath is, and off a vertex it may share with it.
    const probes = subpaths.map(({ start, segments }) => pointOn(start, segments[0], 0.5));
    const around = probes.map((probe, i) =>
        bounds.flatMap(([min, max], j) =>
            j !== i && probe.x >= min.x && probe.x <= max.x && probe.y >= min.y && probe.y <= max.y ? [j] : [],
        ),
    );
    const lengths = subpaths.map(outlineLengthOf);
    const tests = around.flat().reduce((count, j) => count + lengths[j], 0);
    if (!spend(lengths.reduce((count, length) => count + length, tests))) return undefined;
    const outlines = subpaths.map(outlineOf);
    return subpaths.map((subpath, i) => {
        const depth = around[i].filter((j) => encloses(outlines[j], probes[i])).length;
        const area = areaOf(outlines[i]);
        return area !== 0 && area < 0 === (depth % 2 === 0) ? reversed(subpath) : subpath;
    });
}

// Its start and every point its segments name: a curve lies within their bounds.
function pointsOf({ start, segments }: Subpath): Point[] {
    return [start, ...segments.flatMap((segment) => segment.points)];
}

function outlineLengthOf({ start, segments }: Subpath): number {
    let [length, from] = [1, start];
    for (const segment of segments) {
        length += chordsOf(from, segment);
        from = segment.points[segment.points.length - 1];
    }
    return length;
}

// A subpath as a polygon: each line's end, each curve's chords' ends.
function outlineOf({ start, segments }: Subpath): Point[] {
    const outline = [start];
    let from = start;
    for (const segment of segments) {
        const chords = chordsOf(from, segment);
        for (let i = 1; i <= chords; i++) outline.push(pointOn(from, segment, i / chords));
        from = outline[outline.length - 1];
    }
    return outline;
}

// Wang's formula: a curve of degree d lies within the tolerance of √(d(d−1)/8 · m / tolerance) chords, m the largest
// second difference of its control points.
function chordsOf(from: Point, { op, points }: Segment): number {
    if (op === 'L') return 1;
    const controls = [from, ...points];
    let most = 0;
    for (let i = 2; i < controls.length; i++) {
        const [a, b, c] = [controls[i - 2], controls[i - 1], controls[i]];
        most = Math.max(most, Math.hypot(a.x - 2 * b.x + c.x, a.y - 2 * b.y + c.y));
    }
    const degree = points.length;
    const chords = Math.ceil(Math.sqrt((degree * (degree - 1) * most) / (8 * OUTLINE_TOLERANCE)));
    return clamp(chords, 1, MAX_CURVE_CHORDS);
}

// De Casteljau's: the segment's point at t, its end exactly at 1.
function pointOn(from: Point, { points }: Segment, t: number): Point {
    let controls = [from, ...points];
    while (controls.length > 1) {
        const previous = controls;
        controls = previous.slice(1).map((p, i) => ({
            x: previous[i].x * (1 - t) + p.x * t,
            y: previous[i].y * (1 - t) + p.y * t,
        }));
    }
    return controls[0];
}

type Bounds = [min: Point, max: Point];

function boundsOf(points: Point[]): Bounds {
    const [min, max] = [{ ...points[0] }, { ...points[0] }];
    for (const { x, y } of points) {
        [min.x, min.y] = [Math.min(min.x, x), Math.min(min.y, y)];
        [max.x, max.y] = [Math.max(max.x, x), Math.max(max.y, y)];
    }
    return [min, max];
}

// Sharing an edge is no overlap: bricks laid side by side stay one path.
function overlap([aMin, aMax]: Bounds, [bMin, bMax]: Bounds): boolean {
    return aMin.x < bMax.x && bMin.x < aMax.x && aMin.y < bMax.y && bMin.y < aMax.y;
}

// Twice the signed area, positive for a clockwise outline (y down).
function areaOf(outline: Point[]): number {
    let area = 0;
    for (const [i, p] of outline.entries()) {
        const q = outline[(i + 1) % outline.length];
        area += p.x * q.y - q.x * p.y;
    }
    return area;
}

// Even-odd: a ray to the right crosses the outline an odd number of times.
function encloses(outline: Point[], p: Point): boolean {
    let inside = false;
    for (const [i, a] of outline.entries()) {
        const b = outline[(i + 1) % outline.length];
        if (a.y > p.y !== b.y > p.y && p.x < a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y)) inside = !inside;
    }
    return inside;
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
// sweep past a full turn retraces it, so it stops at one: four quarters at most. A negative radius turns the mapping
// half a turn, so its ends can land a turn further apart: the parametric sweep stops at one too.
function arcCurves(from: Point, radii: Point, startAngle: number, sweepAngle: number): Point[][] {
    const start = (startAngle % FULL_TURN) * RADIANS_PER_UNIT;
    const sweep = clamp(sweepAngle, -FULL_TURN, FULL_TURN) * RADIANS_PER_UNIT;
    const parametric = (visual: number) => {
        const turns = Math.round((visual - Math.atan2(Math.sin(visual), Math.cos(visual))) / (2 * Math.PI));
        return Math.atan2(radii.x * Math.sin(visual), radii.y * Math.cos(visual)) + turns * 2 * Math.PI;
    };
    const first = parametric(start);
    const last = first + clamp(parametric(start + sweep) - first, -2 * Math.PI, 2 * Math.PI);
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

// The canonical spelling the canvas reader keeps, or undefined past its caps; a filled path's within them closed.
function pathWithinCaps(subpaths: Subpath[], filled: boolean): string | undefined {
    const closes = filled ? subpaths.filter((subpath) => !subpath.closed).length : 0;
    const commands = subpaths.reduce(
        (count, { segments, closed }) => count + 1 + segments.length + (closed ? 1 : 0),
        closes,
    );
    if (commands > MAX_PATH_COMMANDS) return undefined;
    const parts: string[] = [];
    for (const { start, segments, closed } of subpaths) {
        parts.push(`M ${start.x} ${start.y}`);
        for (const { op, points } of segments) parts.push(`${op} ${points.map(({ x, y }) => `${x} ${y}`).join(' ')}`);
        if (closed) parts.push('Z');
    }
    const path = parts.join(' ');
    return path.length + ' Z'.length * closes <= MAX_PATH_BYTES ? path : undefined;
}

// A filled path as the fill draws it, each subpath closed.
export function closedPath(path: string): string {
    return path
        .split(/ (?=M)/)
        .map((subpath) => (subpath.endsWith('Z') ? subpath : `${subpath} Z`))
        .join(' ');
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
        charge(to - from);
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
