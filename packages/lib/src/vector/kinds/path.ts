import { isTransparentFill, parseFill } from '../fill';
import type { Bounds, Point } from '../geometry';
import { boxCenter, distanceToPolyline, LINEAR_HIT_SCREEN_FACTOR, rotatePoint } from '../geometry';
import { clamp, nearestPoint, polylineOutline, scaledPathCommands } from '../outline';
import { pointsBounds } from '../points';
import type { VectorPathElement } from '../types';
import { boxAnchorPoints, defineKind } from './kind';
import { bool, fillField, parseNormalizedPath } from './read-fields';
import { isBordered, renderRoughShape } from './render-utils';

// A new path fills its box until a caller gives it a contour.
const DEFAULT_PATH = 'M 0 0 L 1 0 L 1 1 L 0 1 Z';
// How far a sampled curve may stray from the drawn one, in scene units.
const CURVE_TOLERANCE = 0.5;
// The most chords one curve samples into, so a path stretched to the coordinate cap stays a bounded hit test.
const MAX_CURVE_STEPS = 64;
// SVG's default stroke-miterlimit: a grown vertex moves at most this many times the inflate.
const MITER_LIMIT = 4;
// The angle one chord of a grown corner's arc turns, in radians: it sags 0.13 units at an inflate of 15.
const JOIN_STEP = Math.PI / 12;

// Hover hit-tests every element and arrow docking outlines every candidate on each pointer move. An edit
// makes a new element object, so a cache keyed by the object never goes stale.
type Sampled = { subpaths: Point[][]; bounds: Bounds };
const SAMPLED = new WeakMap<VectorPathElement, Sampled>();

export const pathKind = defineKind<VectorPathElement>({
    type: 'path',
    is: (el): el is VectorPathElement => el.type === 'path',
    capabilities: {
        fill: true,
        fillStyle: true,
        strokeStyle: true,
        corners: false,
        edges: false,
        strokeOptional: true,
        bindable: true,
        silhouette: 'box',
        creation: 'none',
    },
    // An open path is its stroke: nothing to fill, no edge to dock to, no body without it.
    capabilitiesOf: (el) => (el.closed ? {} : { fill: false, bindable: false, strokeOptional: false }),
    defaults: (style) => ({
        fill: style.fill,
        path: DEFAULT_PATH,
        closed: true,
    }),
    read: (src, base) => {
        const path = parseNormalizedPath(src.get('path'));
        if (path === null) return null;
        return {
            ...base,
            type: 'path',
            fill: fillField(src.get('fill')),
            path,
            closed: bool(src.get('closed'), false) && path.includes('Z'),
        };
    },
    // A control point may pull a curve past the box, so the export, the marquee and the ring read the contour.
    bounds: (el) => grown(sampled(el).bounds, el.strokeWidth / 2),
    // A closed path is hit inside by the fill rule whatever its fill, as the box shapes are; any path on its
    // stroke, within the reach a line has.
    hitTest: (el, point, threshold) => {
        const { subpaths, bounds } = sampled(el);
        const reach = Math.max(threshold * LINEAR_HIT_SCREEN_FACTOR, el.strokeWidth / 2 + 0.1);
        const near = grown(bounds, reach);
        if (point.x < near.minX || point.x > near.maxX || point.y < near.minY || point.y > near.maxY) return false;
        const p = rotatePoint(point, boxCenter(el), -el.angle);
        if (subpaths.some((points) => distanceToPolyline(points, p) <= reach)) return true;
        return el.closed && winding(subpaths, p) !== 0;
    },
    // The outer contour only: an arrow docks on the outside of a shape with a hole.
    outline: (el, inflate) => {
        const outer = outerContour(sampled(el).subpaths);
        if (!el.closed) return polylineOutline(outer);
        return { kind: 'polygon', corners: grownRing(outer, inflate) };
    },
    // The box's side midpoints moved onto the outer contour, so a snap dot sits where an arrow docks.
    anchorPoints: (el) => {
        const outer = outerContour(sampled(el).subpaths);
        const center = boxCenter(el);
        return boxAnchorPoints(el).map((m) =>
            rotatePoint(nearestOnPolyline(outer, rotatePoint(m, center, -el.angle)), center, el.angle),
        );
    },
    paintsNothing: (el) => !isBordered(el) && (!el.closed || isTransparentFill(parseFill(el.fill))),
    render: (el) => ({ svg: renderRoughShape(el) }),
});

// Every subpath as a polyline in the unrotated scene frame, its curves flattened, a closed one ending on
// its start; and the box of those points rotated as drawn.
function sampled(el: VectorPathElement): Sampled {
    const cached = SAMPLED.get(el);
    if (cached) return cached;
    const at = (p: Point): Point => ({ x: el.x + p.x, y: el.y + p.y });
    const subpaths: Point[][] = [];
    let current: Point[] = [];
    for (const { op, points } of scaledPathCommands(el.path, el.width, el.height)) {
        if (op === 'M') {
            current = [at(points[0])];
            subpaths.push(current);
        } else if (op === 'Z') {
            current.push(current[0]);
        } else {
            current.push(...flatten([current[current.length - 1], ...points.map(at)]));
        }
    }
    const center = boxCenter(el);
    const entry = { subpaths, bounds: pointsBounds(subpaths.flat().map((p) => rotatePoint(p, center, el.angle))) };
    SAMPLED.set(el, entry);
    return entry;
}

function grown(b: Bounds, by: number): Bounds {
    return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

// A line's end, or a Bézier's points after its start in enough steps that no chord strays more than
// CURVE_TOLERANCE from the curve (Wang's bound on the control polygon's second differences).
function flatten(control: Point[]): Point[] {
    const degree = control.length - 1;
    let bend = 0;
    for (let i = 2; i < control.length; i++) {
        const a = control[i - 2];
        const b = control[i - 1];
        const c = control[i];
        bend = Math.max(bend, Math.hypot(a.x - 2 * b.x + c.x, a.y - 2 * b.y + c.y));
    }
    const wang = Math.ceil(Math.sqrt((degree * (degree - 1) * bend) / (8 * CURVE_TOLERANCE)));
    const steps = Math.min(Math.max(wang, 1), MAX_CURVE_STEPS);
    const out: Point[] = [];
    for (let s = 1; s < steps; s++) out.push(bezierAt(control, s / steps));
    out.push(control[degree]);
    return out;
}

function bezierAt(control: Point[], t: number): Point {
    let points = control;
    while (points.length > 1) {
        const previous = points;
        points = previous.slice(1).map((p, i) => ({
            x: previous[i].x + (p.x - previous[i].x) * t,
            y: previous[i].y + (p.y - previous[i].y) * t,
        }));
    }
    return points[0];
}

// The nonzero winding number of `p` over every subpath, each closed back to its start as a fill closes it.
function winding(subpaths: Point[][], p: Point): number {
    let total = 0;
    for (const ring of subpaths) {
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
            if (a.y <= p.y && b.y > p.y && side > 0) total++;
            else if (a.y > p.y && b.y <= p.y && side < 0) total--;
        }
    }
    return total;
}

// Twice the signed area, positive for a ring wound clockwise on screen (y down).
function signedArea(ring: Point[]): number {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        sum += a.x * b.y - b.x * a.y;
    }
    return sum;
}

function nearestOnPolyline(points: Point[], to: Point): Point {
    const feet = points.slice(1).map((b, i) => {
        const a = points[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : clamp(((to.x - a.x) * dx + (to.y - a.y) * dy) / len2, 0, 1);
        return { x: a.x + t * dx, y: a.y + t * dy };
    });
    return nearestPoint([points[0], ...feet], to);
}

function outerContour(subpaths: Point[][]): Point[] {
    let outer: Point[] = [];
    let area = -1;
    for (const ring of subpaths) {
        const a = Math.abs(signedArea(ring));
        if (a > area) {
            outer = ring;
            area = a;
        }
    }
    return outer;
}

// Every edge moved `inflate` outward (inward when negative), so a point of the result lies `inflate` off the
// contour, as the binding gap means. Where two moved edges part, an arc about the vertex joins them (a
// miter would put a sharp tip's dock far past the gap); where they overlap they meet at the miter, held at
// MITER_LIMIT where the contour nearly doubles back.
function grownRing(ring: Point[], inflate: number): Point[] {
    const points = ring.filter((p, i) => {
        const next = ring[(i + 1) % ring.length];
        return p.x !== next.x || p.y !== next.y;
    });
    if (points.length < 3) return [];
    if (inflate === 0) return points;
    const sign = Math.sign(signedArea(points));
    const normal = (a: Point, b: Point): Point => {
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        return { x: (sign * (b.y - a.y)) / len, y: (sign * (a.x - b.x)) / len };
    };
    const out: Point[] = [];
    points.forEach((p, i) => {
        const prev = points[(i + points.length - 1) % points.length];
        const next = points[(i + 1) % points.length];
        const n1 = normal(prev, p);
        const n2 = normal(p, next);
        const turn = (p.x - prev.x) * (next.y - p.y) - (p.y - prev.y) * (next.x - p.x);
        if (turn * sign * inflate > 0) {
            const from = Math.atan2(n1.y, n1.x);
            const sweep = Math.atan2(n1.x * n2.y - n1.y * n2.x, n1.x * n2.x + n1.y * n2.y);
            const steps = Math.ceil(Math.abs(sweep) / JOIN_STEP);
            for (let s = 0; s <= steps; s++) {
                const a = from + (sweep * s) / steps;
                out.push({ x: p.x + Math.cos(a) * inflate, y: p.y + Math.sin(a) * inflate });
            }
            return;
        }
        const k = Math.max(1 + n1.x * n2.x + n1.y * n2.y, 2 / MITER_LIMIT ** 2);
        out.push({ x: p.x + ((n1.x + n2.x) * inflate) / k, y: p.y + ((n1.y + n2.y) * inflate) / k });
    });
    return out;
}
