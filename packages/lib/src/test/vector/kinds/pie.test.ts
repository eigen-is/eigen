import { describe, expect, test } from 'bun:test';
import { elbowBindPoint } from '../../../vector/elbow-heading';
import { solidFill } from '../../../vector/fill';
import type { Point } from '../../../vector/geometry';
import {
    bindingAnchor,
    bindingGap,
    boundEndpoint,
    rotatePoint,
    serializePoints,
    shapeAnchorPoints,
} from '../../../vector/geometry';
import { ELEMENT_KINDS } from '../../../vector/kinds';
import { distanceToSegment, ellipseOutline, outlineContains } from '../../../vector/outline';
import { readElementFromFields } from '../../../vector/read-vector';
import type { VectorPieElement } from '../../../vector/types';
import { serializeBinding } from '../../../vector/types';
import { arrow, byIdOf, ellipse, pie } from '../element-factories';

// A circular slice centered on (100, 100) with radius 100, so the oracle below is plain circle geometry.
const slice = (startAngle: number, sweepAngle: number, over: Partial<VectorPieElement> = {}): VectorPieElement =>
    pie({ id: 'p', x: 0, y: 0, width: 200, height: 200, strokeWidth: 2, startAngle, sweepAngle, ...over });

const C = { x: 100, y: 100 };
const R = 100;
const DEG = Math.PI / 180;

const polar = (deg: number, r: number): Point => ({
    x: C.x + r * Math.cos(deg * DEG),
    y: C.y + r * Math.sin(deg * DEG),
});

// The test's own oracle: distance from p to the drawn circular slice — 0 inside, else the nearer of the two
// radii and, when p faces the arc, the arc.
function sliceDistance(startAngle: number, sweepAngle: number, p: Point): number {
    const d = Math.hypot(p.x - C.x, p.y - C.y);
    const rel = (((Math.atan2(p.y - C.y, p.x - C.x) / DEG - startAngle) % 360) + 360) % 360;
    const facing = rel <= sweepAngle;
    if (facing && d <= R) return 0;
    const radii = [
        distanceToSegment(p, C, polar(startAngle, R)),
        distanceToSegment(p, C, polar(startAngle + sweepAngle, R)),
    ];
    return Math.min(...radii, facing ? d - R : Number.POSITIVE_INFINITY);
}

const fields = (record: Record<string, unknown>) => new Map(Object.entries({ id: 'p', type: 'pie', ...record }));

const readPie = (record: Record<string, unknown>): VectorPieElement => {
    const el = readElementFromFields(fields(record));
    if (el?.type !== 'pie') throw new Error('expected a pie');
    return el;
};

describe('pie read', () => {
    test('a missing angle reads as a quarter starting at 12 o’clock', () => {
        const el = readPie({});
        expect(el.startAngle).toBe(270);
        expect(el.sweepAngle).toBe(90);
    });

    test('startAngle normalizes into [0, 360)', () => {
        expect(readPie({ startAngle: -90 }).startAngle).toBe(270);
        expect(readPie({ startAngle: 450 }).startAngle).toBe(90);
        expect(readPie({ startAngle: 360 }).startAngle).toBe(0);
        expect(readPie({ startAngle: 'east' }).startAngle).toBe(270);
        expect(readPie({ startAngle: Number.POSITIVE_INFINITY }).startAngle).toBe(270);
    });

    test('sweepAngle stays in (0, 360]: a full turn is a whole slice, nothing at all is malformed', () => {
        expect(readPie({ sweepAngle: 45.5 }).sweepAngle).toBe(45.5);
        expect(readPie({ sweepAngle: 360 }).sweepAngle).toBe(360);
        expect(readPie({ sweepAngle: 400 }).sweepAngle).toBe(360);
        expect(readPie({ sweepAngle: 0 }).sweepAngle).toBe(90);
        expect(readPie({ sweepAngle: -30 }).sweepAngle).toBe(90);
        expect(readPie({ sweepAngle: Number.NaN }).sweepAngle).toBe(90);
        expect(readPie({ sweepAngle: '30' }).sweepAngle).toBe(90);
    });

    test('a well-formed slice reads back as itself', () => {
        const el = slice(30, 120, { fill: solidFill('#ff0000') });
        expect(readElementFromFields(new Map(Object.entries(el)))).toEqual(el);
    });
});

describe('pie hit test', () => {
    const kind = ELEMENT_KINDS.pie;

    test('a 30° slice is hit inside its sector only', () => {
        const el = slice(0, 30);
        expect(kind.hitTest(el, polar(15, 50), 0)).toBe(true);
        expect(kind.hitTest(el, polar(45, 50), 0)).toBe(false);
        expect(kind.hitTest(el, polar(-15, 50), 0)).toBe(false);
        expect(kind.hitTest(el, polar(15, 110), 0)).toBe(false);
    });

    test('the threshold widens the hit by a band around the drawn edge', () => {
        const el = slice(0, 30);
        expect(kind.hitTest(el, polar(15, 104), 0)).toBe(false);
        expect(kind.hitTest(el, polar(15, 104), 8)).toBe(true);
        // just behind the apex
        expect(kind.hitTest(el, { x: 95, y: 100 }, 0)).toBe(false);
        expect(kind.hitTest(el, { x: 95, y: 100 }, 8)).toBe(true);
        expect(kind.hitTest(el, polar(60, 50), 8)).toBe(false);
    });

    test('a 270° slice leaves its notch empty', () => {
        const el = slice(0, 270);
        expect(kind.hitTest(el, polar(315, 50), 0)).toBe(false);
        expect(kind.hitTest(el, polar(300, 90), 0)).toBe(false);
        expect(kind.hitTest(el, polar(200, 50), 0)).toBe(true);
        expect(kind.hitTest(el, polar(100, 90), 0)).toBe(true);
    });

    test('a rotated slice is hit where it is drawn', () => {
        const el = slice(0, 30, { angle: 90 });
        expect(kind.hitTest(el, polar(105, 50), 0)).toBe(true);
        expect(kind.hitTest(el, polar(15, 50), 0)).toBe(false);
    });

    test('a slice of a wide box measures its angles in the box-normalized circle', () => {
        // 200×100: (+60, +30) from the center normalizes to (0.6, 0.6), 45° and inside the unit circle.
        const el = pie({ id: 'p', x: 0, y: 0, width: 200, height: 100, startAngle: 0, sweepAngle: 90 });
        expect(kind.hitTest(el, { x: 160, y: 80 }, 0)).toBe(true);
        expect(kind.hitTest(el, { x: 190, y: 90 }, 0)).toBe(false);
        expect(kind.hitTest(el, { x: 160, y: 20 }, 0)).toBe(false);
    });

    test('a collapsed box is never hit', () => {
        expect(kind.hitTest(slice(0, 30, { width: 0 }), C, 8)).toBe(false);
    });
});

describe('pie outline', () => {
    test('a whole slice docks on the ellipse outline', () => {
        const el = slice(40, 360);
        expect(ELEMENT_KINDS.pie.outline(el, 6)).toEqual(ellipseOutline({ x: 0, y: 0, width: 200, height: 200 }, 6));
    });

    test('a shrunk outline keeps only what lies deeper than the inset', () => {
        // the see-through binding band asks this with a negative inflate
        const thin = ELEMENT_KINDS.pie.outline(slice(0, 30), -15);
        expect(outlineContains(thin, polar(15, 80))).toBe(true);
        expect(outlineContains(thin, polar(15, 50))).toBe(false);
        const wide = ELEMENT_KINDS.pie.outline(slice(0, 270), -15);
        expect(outlineContains(wide, polar(200, 50))).toBe(true);
        expect(outlineContains(wide, polar(200, 90))).toBe(false);
        expect(outlineContains(wide, polar(10, 50))).toBe(false);
        expect(outlineContains(wide, polar(315, 10))).toBe(false);
        expect(ELEMENT_KINDS.pie.outline(slice(0, 5), -15)).toEqual({ kind: 'polygon', corners: [] });
    });

    test('a slice past 180° contains its own body and not its notch', () => {
        const outline = ELEMENT_KINDS.pie.outline(slice(0, 270), 0);
        expect(outlineContains(outline, polar(200, 50))).toBe(true);
        expect(outlineContains(outline, polar(10, 90))).toBe(true);
        expect(outlineContains(outline, polar(315, 50))).toBe(false);
    });
});

describe('pie docking', () => {
    // A straight arrow from `from` to an anchor inside the slice, bound at its end.
    const arrowTo = (el: VectorPieElement, from: Point, anchor: Point) => {
        const x = Math.min(from.x, anchor.x);
        const y = Math.min(from.y, anchor.y);
        return arrow({
            id: 'a',
            x,
            y,
            width: Math.abs(anchor.x - from.x),
            height: Math.abs(anchor.y - from.y),
            roundness: 'sharp',
            points: serializePoints([
                { x: from.x - x, y: from.y - y },
                { x: anchor.x - x, y: anchor.y - y },
            ]),
            endBinding: serializeBinding({ elementId: el.id, fixedPoint: bindingAnchor(el, anchor) }),
        });
    };

    const dockGap = (el: VectorPieElement, from: Point, anchor: Point): number => {
        const dock = boundEndpoint(arrowTo(el, from, anchor), 'end', el, byIdOf(el));
        return sliceDistance(el.startAngle, el.sweepAngle, dock);
    };

    test('an arrow at a 30° slice docks the binding gap off its arc', () => {
        const el = slice(0, 30);
        expect(dockGap(el, polar(15, 400), polar(15, 50))).toBeCloseTo(bindingGap(el), 1);
    });

    test('an arrow at a 30° slice docks the binding gap off its radius', () => {
        const el = slice(0, 30);
        // the end radius' midpoint, approached along its outward normal
        const mid = polar(30, 50);
        const out = { x: -Math.sin(30 * DEG), y: Math.cos(30 * DEG) };
        const from = { x: mid.x + 200 * out.x, y: mid.y + 200 * out.y };
        const anchor = { x: mid.x - 10 * out.x, y: mid.y - 10 * out.y };
        expect(dockGap(el, from, anchor)).toBeCloseTo(bindingGap(el), 1);
    });

    test('an arrow from behind a 30° slice docks the binding gap off its apex, not at a far miter tip', () => {
        const el = slice(0, 30);
        expect(dockGap(el, polar(195, 300), polar(15, 30))).toBeCloseTo(bindingGap(el), 1);
    });

    test('an arrow through the notch of a 270° slice docks the binding gap off the radius it meets', () => {
        // straight down at x = 160: the notch is the top-right quadrant, so the first edge is the 0° radius
        const el = slice(0, 270);
        expect(dockGap(el, { x: 160, y: -100 }, { x: 160, y: 140 })).toBeCloseTo(bindingGap(el), 1);
    });

    test('a rotated slice docks where it is drawn', () => {
        const el = slice(0, 30, { angle: 90 });
        const dock = boundEndpoint(arrowTo(el, polar(105, 400), polar(105, 50)), 'end', el, byIdOf(el));
        // undo the rotation and measure against the unrotated slice
        expect(sliceDistance(0, 30, rotatePoint(dock, C, -90))).toBeCloseTo(bindingGap(el), 1);
    });

    test('an elbow end dropped on a 30° slice docks on the slice', () => {
        const el = slice(0, 30);
        const { dock } = elbowBindPoint(el, polar(15, 90));
        expect(sliceDistance(0, 30, dock)).toBeCloseTo(bindingGap(el), 1);
    });
});

describe('pie anchors', () => {
    test('the four anchors sit on the slice: arc middle, both radius middles, apex', () => {
        const el = slice(0, 30);
        const anchors = shapeAnchorPoints(el);
        const expected = [polar(15, R), polar(0, R / 2), polar(30, R / 2), C];
        expect(anchors).toHaveLength(4);
        for (let i = 0; i < 4; i++) {
            expect(anchors[i].x).toBeCloseTo(expected[i].x, 9);
            expect(anchors[i].y).toBeCloseTo(expected[i].y, 9);
            expect(sliceDistance(0, 30, anchors[i])).toBeCloseTo(0, 9);
        }
    });

    test('the anchors turn with the element', () => {
        const flat = shapeAnchorPoints(slice(0, 30));
        const turned = shapeAnchorPoints(slice(0, 30, { angle: 90 }));
        for (let i = 0; i < 4; i++) {
            const want = rotatePoint(flat[i], C, 90);
            expect(turned[i].x).toBeCloseTo(want.x, 9);
            expect(turned[i].y).toBeCloseTo(want.y, 9);
        }
    });
});

// How far the drawn rim strays from the circle of radius r about (c, c): every stroked cubic that starts and
// ends on the rim, sampled.
function rimError(svg: string, c: number, r: number): number {
    const onRim = (x: number, y: number) => Math.abs(Math.hypot(x - c, y - c) - r) < 0.5;
    let error = 0;
    for (const [, d] of svg.matchAll(/<path d="([^"]+)" stroke="(?!none)/g)) {
        let from = [0, 0];
        for (const [, op, args] of d.matchAll(/([MLC])([^MLC]+)/g)) {
            const v = args.trim().split(/\s+/).map(Number);
            if (op === 'C' && onRim(from[0], from[1]) && onRim(v[4], v[5])) {
                for (let t = 0; t <= 1; t += 0.01) {
                    const u = 1 - t;
                    const x = u ** 3 * from[0] + 3 * u * u * t * v[0] + 3 * u * t * t * v[2] + t ** 3 * v[4];
                    const y = u ** 3 * from[1] + 3 * u * u * t * v[1] + 3 * u * t * t * v[3] + t ** 3 * v[5];
                    error = Math.max(error, Math.abs(Math.hypot(x - c, y - c) - r));
                }
            }
            from = op === 'C' ? [v[4], v[5]] : v;
        }
    }
    return error;
}

describe('pie render', () => {
    const svgOf = (el: VectorPieElement): string => {
        const out = ELEMENT_KINDS.pie.render(el, {});
        if ('html' in out) throw new Error('a pie must render svg');
        return out.svg;
    };

    test('a large flat slice draws its rim as smoothly as the ellipse', () => {
        const big = { x: 0, y: 0, width: 2400, height: 2400, roughness: 0 };
        // A whole slice is the ellipse's drawable (pinned below), so this is the ellipse's rim.
        const circle = svgOf(slice(0, 360, big));
        for (const sweep of [30, 90, 119, 179, 300]) {
            const svg = svgOf(slice(10, sweep, big));
            expect(svg).toContain(' C');
            expect([sweep, rimError(svg, 1200, 1200)]).toEqual([sweep, expect.closeTo(0, 1)]);
            expect(rimError(svg, 1200, 1200)).toBeLessThanOrEqual(rimError(circle, 1200, 1200));
        }
    });

    test('a slice draws a closed arc: both radii run from the apex to the arc ends', () => {
        const svg = svgOf(slice(0, 30, { roughness: 0 }));
        expect(svg).toContain('M100 100');
        expect(svg).toContain('200 100');
        expect(svg).toContain(`${Math.round(polar(30, R).x * 100) / 100} ${Math.round(polar(30, R).y * 100) / 100}`);
    });

    test('a filled slice paints its fill', () => {
        expect(svgOf(slice(0, 30, { fill: solidFill('#ff0000') }))).toContain('fill="#ff0000"');
    });

    test('a whole slice draws exactly the ellipse', () => {
        const base = {
            id: 'e',
            x: 0,
            y: 0,
            width: 200,
            height: 120,
            roughness: 1,
            seed: 7,
            fill: solidFill('#00ff00'),
        };
        const whole = ELEMENT_KINDS.pie.render(pie({ ...base, startAngle: 123, sweepAngle: 360 }), {});
        expect(whole).toEqual(ELEMENT_KINDS.ellipse.render(ellipse(base), {}));
    });

    test('a slice with neither fill nor border paints nothing', () => {
        expect(ELEMENT_KINDS.pie.paintsNothing(slice(0, 30, { strokeColor: 'transparent' }))).toBe(true);
        expect(ELEMENT_KINDS.pie.paintsNothing(slice(0, 30))).toBe(false);
    });
});
