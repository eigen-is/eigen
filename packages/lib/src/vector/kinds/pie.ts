import type { Point } from '../geometry';
import { boxCenter, DEG_TO_RAD, rotatePoint } from '../geometry';
import type { OutlineShape } from '../outline';
import { EMPTY_OUTLINE, ellipseOutline, normalizeAngle, outlineDistance } from '../outline';
import type { VectorPieElement } from '../types';
import { defineKind } from './kind';
import { fillField, num } from './read-fields';
import { isUnpainted, renderRoughShape } from './render-utils';

// A new slice is a quarter from 12 o'clock, where a pie chart's first slice starts.
const DEFAULT_START_ANGLE = 270;
const DEFAULT_SWEEP_ANGLE = 90;
// The docking polygon's arc step in degrees: the chord sags 0.15 units at radius 1000.
const ARC_STEP = 2;

export const pieKind = defineKind<VectorPieElement>({
    type: 'pie',
    is: (el): el is VectorPieElement => el.type === 'pie',
    // `ellipse` silhouette: the slice is a piece of its box's ellipse, so the elbow dock must neither slide
    // off a box corner nor snap to a diamond vertex, both of which lie outside the slice.
    capabilities: {
        fill: true,
        fillStyle: true,
        strokeStyle: true,
        corners: false,
        edges: false,
        strokeOptional: true,
        bindable: true,
        silhouette: 'ellipse',
        creation: 'none',
    },
    defaults: (style) => ({
        fill: style.fill,
        startAngle: DEFAULT_START_ANGLE,
        sweepAngle: DEFAULT_SWEEP_ANGLE,
    }),
    read: (src, base) => ({
        ...base,
        type: 'pie',
        fill: fillField(src.get('fill')),
        startAngle: normalizeAngle(num(src.get('startAngle'), DEFAULT_START_ANGLE)),
        sweepAngle: sweepField(src.get('sweepAngle')),
    }),
    hitTest: (el, point, threshold) => {
        if (el.width <= 0 || el.height <= 0) return false;
        const p = rotatePoint(point, boxCenter(el), -el.angle);
        return inSector(el, p) || outlineDistance(pieOutline(el, 0), p) <= threshold;
    },
    outline: (el, inflate) => pieOutline(el, inflate),
    anchorPoints: (el) => {
        const c = boxCenter(el);
        const rx = el.width / 2;
        const ry = el.height / 2;
        const end = el.startAngle + el.sweepAngle;
        return [
            onEllipse(c, rx, ry, el.startAngle + el.sweepAngle / 2),
            onEllipse(c, rx / 2, ry / 2, el.startAngle),
            onEllipse(c, rx / 2, ry / 2, end),
            c,
        ].map((p) => rotatePoint(p, c, el.angle));
    },
    paintsNothing: isUnpainted,
    render: (el) => ({ svg: renderRoughShape(el) }),
});

// A slice of nothing is malformed, not empty: a chart leaves a zero value out.
function sweepField(v: unknown): number {
    const sweep = num(v, DEFAULT_SWEEP_ANGLE);
    return sweep > 0 ? Math.min(sweep, 360) : DEFAULT_SWEEP_ANGLE;
}

function onEllipse(c: Point, rx: number, ry: number, deg: number): Point {
    return { x: c.x + rx * Math.cos(deg * DEG_TO_RAD), y: c.y + ry * Math.sin(deg * DEG_TO_RAD) };
}

// `p` in the unrotated frame. In the box-normalized circle the angles are the stored ones.
function inSector(el: VectorPieElement, p: Point): boolean {
    const c = boxCenter(el);
    const u = (p.x - c.x) / (el.width / 2);
    const v = (p.y - c.y) / (el.height / 2);
    if (u * u + v * v > 1) return false;
    return el.sweepAngle >= 360 || normalizeAngle(Math.atan2(v, u) / DEG_TO_RAD - el.startAngle) <= el.sweepAngle;
}

// `from` to `to` degrees on an ellipse, both ends included, at most ARC_STEP apart.
function arcPoints(c: Point, rx: number, ry: number, from: number, to: number): Point[] {
    const steps = Math.max(1, Math.ceil(Math.abs(to - from) / ARC_STEP));
    const out: Point[] = [];
    for (let i = 0; i <= steps; i++) out.push(onEllipse(c, rx, ry, from + ((to - from) * i) / steps));
    return out;
}

// The slice's edge grown by `inflate` (shrunk when negative), in the unrotated scene frame. The arc's radii
// grow by `inflate`, as the ellipse's do; each radius moves `inflate` along its outward normal. Where the
// two offset radii meet behind the apex they miter. Where they part, a disc about the apex joins them, so
// a thin slice docks an arrow from behind at the gap rather than at a far miter tip.
function pieOutline(el: VectorPieElement, inflate: number): OutlineShape {
    const box = { x: el.x, y: el.y, width: el.width, height: el.height };
    if (el.sweepAngle >= 360) return ellipseOutline(box, inflate);
    const rx = el.width / 2;
    const ry = el.height / 2;
    const a = rx + inflate;
    const b = ry + inflate;
    if (rx <= 0 || ry <= 0 || a <= 0 || b <= 0) return EMPTY_OUTLINE;
    const c = boxCenter(el);
    const start = el.startAngle;
    const end = start + el.sweepAngle;
    const ds = unit(onEllipse({ x: 0, y: 0 }, rx, ry, start));
    const de = unit(onEllipse({ x: 0, y: 0 }, rx, ry, end));
    // The sweep runs clockwise, so the start radius faces counter-clockwise and the end radius clockwise.
    const ns = { x: ds.y, y: -ds.x };
    const ne = { x: -de.y, y: de.x };

    const arcStart = rimAngle(ds, ns, inflate, a, b, start);
    const arcEnd = rimAngle(de, ne, inflate, a, b, end);
    if (arcStart === null || arcEnd === null || arcEnd <= arcStart) return EMPTY_OUTLINE;
    const arc = arcPoints(c, a, b, arcStart, arcEnd);

    if (inflate === 0) return { kind: 'polygon', corners: [c, ...arc] };
    const convex = el.sweepAngle < 180;
    const grown = inflate > 0;
    if (grown === convex) {
        const from = Math.atan2(ne.y, ne.x) / DEG_TO_RAD;
        const turn = normalizeAngle(Math.atan2(ns.y, ns.x) / DEG_TO_RAD - from);
        const cap = arcPoints(c, inflate, inflate, from, from + (convex ? turn : turn - 360));
        return { kind: 'polygon', corners: [...cap, ...arc] };
    }
    const k = inflate / (1 + ns.x * ne.x + ns.y * ne.y);
    const apex = { x: c.x + (ns.x + ne.x) * k, y: c.y + (ns.y + ne.y) * k };
    // A miter past the rim means the offset closed the notch (grown) or swallowed the slice (shrunk).
    if (!(((apex.x - c.x) / a) ** 2 + ((apex.y - c.y) / b) ** 2 < 1)) {
        return grown ? ellipseOutline(box, inflate) : EMPTY_OUTLINE;
    }
    return { kind: 'polygon', corners: [apex, ...arc] };
}

// Where the radius along `d`, offset by `inflate` along `n`, meets the grown ellipse (a, b), as that
// ellipse's angle unwrapped next to `near`. null when the offset line misses it.
function rimAngle(d: Point, n: Point, inflate: number, a: number, b: number, near: number): number | null {
    const ox = n.x * inflate;
    const oy = n.y * inflate;
    const A = (d.x / a) ** 2 + (d.y / b) ** 2;
    const B = 2 * ((ox * d.x) / (a * a) + (oy * d.y) / (b * b));
    const C = (ox / a) ** 2 + (oy / b) ** 2 - 1;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const s = (-B + Math.sqrt(disc)) / (2 * A);
    const deg = Math.atan2((oy + s * d.y) / b, (ox + s * d.x) / a) / DEG_TO_RAD;
    return near + normalizeAngle(deg - near + 180) - 180;
}

function unit(p: Point): Point {
    const len = Math.hypot(p.x, p.y);
    return { x: p.x / len, y: p.y / len };
}
