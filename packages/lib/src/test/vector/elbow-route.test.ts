import { describe, expect, test } from 'bun:test';
import { elbowRoute } from '../../vector/elbow-route';
import type { Bounds, Point } from '../../vector/geometry';
import {
    DEFAULT_ELEMENT_PROPS,
    serializeBinding,
    type VectorArrowElement,
    type VectorElement,
    type VectorShapeElement,
} from '../../vector/types';

const shapeEl = (over: Partial<VectorShapeElement> & Pick<VectorShapeElement, 'id' | 'type'>): VectorShapeElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    seed: 1,
    index: 'a0',
    roundness: 'sharp',
    ...over,
});

const arrowEl = (over: Partial<VectorArrowElement> & { points: string }): VectorArrowElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    id: 'ar',
    type: 'arrow',
    x: 0,
    y: 0,
    width: 100,
    height: 0,
    angle: 0,
    seed: 1,
    index: 'a0',
    roundness: 'sharp',
    elbow: true,
    fixedSegments: '',
    startArrowhead: 'none',
    endArrowhead: 'arrow',
    startBinding: '',
    endBinding: '',
    text: '',
    fontSize: 20,
    fontFamily: 'Excalifont',
    labelWidth: 0,
    ...over,
});

const bind = (shape: VectorShapeElement, fixedPoint: [number, number]): string =>
    serializeBinding({ elementId: shape.id, fixedPoint });

const byIdOf = (...els: VectorElement[]): Map<string, VectorElement> => new Map(els.map((e) => [e.id, e]));

// Consecutive vertices differ on exactly one axis (a right angle at every bend, no diagonals).
const isOrthogonal = (route: Point[]): boolean => {
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1];
        const b = route[i];
        if (a.x !== b.x && a.y !== b.y) return false;
    }
    return true;
};

const strictlyInside = (p: Point, b: Bounds): boolean => p.x > b.minX && p.x < b.maxX && p.y > b.minY && p.y < b.maxY;

describe('elbowRoute', () => {
    test('is deterministic — the same arrow + shapes route identically every call', () => {
        const a = shapeEl({ id: 'A', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 });
        const b = shapeEl({ id: 'B', type: 'rectangle', x: 200, y: 200, width: 100, height: 100 });
        const arrow = arrowEl({
            points: '[[100,50],[250,200]]',
            startBinding: bind(a, [1, 0.5]),
            endBinding: bind(b, [0.5, 0]),
        });
        const byId = byIdOf(a, b, arrow);
        expect(elbowRoute(arrow, byId)).toEqual(elbowRoute(arrow, byId));
    });

    test('a two-rect route is all right angles, bends at least once, and clears both shape interiors', () => {
        const a = shapeEl({ id: 'A', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 });
        const b = shapeEl({ id: 'B', type: 'rectangle', x: 200, y: 200, width: 100, height: 100 });
        const arrow = arrowEl({
            points: '[[100,50],[250,200]]',
            startBinding: bind(a, [1, 0.5]),
            endBinding: bind(b, [0.5, 0]),
        });
        const route = elbowRoute(arrow, byIdOf(a, b, arrow));

        expect(isOrthogonal(route)).toBe(true);
        expect(route.length).toBeGreaterThanOrEqual(3); // a snake, not a straight line
        // The arrow's local frame equals scene here (x/y 0, angle 0), so the raw shape AABBs are these.
        const aabbA: Bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
        const aabbB: Bounds = { minX: 200, minY: 200, maxX: 300, maxY: 300 };
        for (let i = 1; i < route.length; i++) {
            const mid = { x: (route[i - 1].x + route[i].x) / 2, y: (route[i - 1].y + route[i].y) / 2 };
            expect(strictlyInside(mid, aabbA)).toBe(false);
            expect(strictlyInside(mid, aabbB)).toBe(false);
        }
    });

    test('an unbound elbow snakes: right-angled with a bend when the endpoints are diagonal', () => {
        const arrow = arrowEl({ points: '[[0,0],[100,80]]' });
        const route = elbowRoute(arrow, byIdOf(arrow));
        expect(isOrthogonal(route)).toBe(true);
        expect(route.length).toBeGreaterThanOrEqual(3);
        expect(route[0]).toEqual({ x: 0, y: 0 });
        expect(route[route.length - 1]).toEqual({ x: 100, y: 80 });
    });

    test('an unbound elbow collapses to a straight segment when the endpoints already align', () => {
        const arrow = arrowEl({ points: '[[0,0],[100,0]]' });
        expect(elbowRoute(arrow, byIdOf(arrow))).toEqual([
            { x: 0, y: 0 },
            { x: 100, y: 0 },
        ]);
    });

    test('a degenerate arrow (< 2 points) passes through untouched', () => {
        const arrow = arrowEl({ points: '[[5,5]]' });
        expect(elbowRoute(arrow, byIdOf(arrow))).toEqual([{ x: 5, y: 5 }]);
    });
});

// The parity contract: exact routes verified point-for-point against Excalidraw's own no-fixed-segments
// pipeline (getElbowArrowData → routeElbowArrow → removeElbowArrowShortSegments → getElbowArrowCornerPoints)
// run on the identical inputs (a faithful copy of that pipeline was used as the oracle). U1 routes from the
// STORED endpoints — the same points the endpoint dot renders at — so every terminal below equals the arrow's
// stored point exactly; U2 will make the stored point the fixedPoint-derived dock, closing the last gap to
// Excalidraw's globalFixedPoint terminal. Where these differ from the hand-computed numbers in
// ELBOW-PARITY-SPEC (E9's bend row, E10's "tight S"), the spec's arithmetic was the approximation.
// CAVEAT: these expected tuples are CAPTURED FROM OUR PORT of that pipeline, not from an independent
// Excalidraw run — so they pin against regression, not against the source. The real check that the port
// matches Excalidraw is line-level review of elbow-route.ts / elbow-heading.ts against the reference files.
describe('elbowRoute — exact parity with Excalidraw', () => {
    const asPairs = (route: Point[]): [number, number][] => route.map((p) => [p.x, p.y]);

    test('E9 — a fully-unbound Z bends at the ±2-box midline, not the endpoint stub', () => {
        const arrow = arrowEl({ points: '[[0,0],[10,200]]' });
        expect(asPairs(elbowRoute(arrow, byIdOf(arrow)))).toEqual([
            [0, 0],
            [0, 100],
            [10, 100],
            [10, 200],
        ]);
    });

    test('E2 — a close bound endpoint leaves through the search-cone side (UP), not the quadrant', () => {
        // Rect 200×100 at (0,0); the start sits at (160,10) — |offset.x|>|offset.y| quadrant says RIGHT, but
        // the ×2 UP cone of the wide box claims it, so the first segment goes UP.
        const r = shapeEl({ id: 'R', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 });
        const arrow = arrowEl({ points: '[[160,10],[400,400]]', startBinding: bind(r, [0.8, 0.1]) });
        expect(asPairs(elbowRoute(arrow, byIdOf(r, arrow)))).toEqual([
            [160, 10],
            [160, -42],
            [400, -42],
            [400, 400],
        ]);
    });

    test('E10 — two close rects route the tight S through the half-gap corridor', () => {
        // A(0,0,100,100) and B(140,40,100,100), stroke 2 → gap 6; endpoints (106,50) and (134,90). Their padded
        // boxes overlap → obstacles collapse to the point boxes and A* threads the gap.
        const a = shapeEl({ id: 'A', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 });
        const b = shapeEl({ id: 'B', type: 'rectangle', x: 140, y: 40, width: 100, height: 100 });
        const arrow = arrowEl({
            points: '[[106,50],[134,90]]',
            startBinding: bind(a, [1.06, 0.5]),
            endBinding: bind(b, [-0.06, 0.5]),
        });
        expect(asPairs(elbowRoute(arrow, byIdOf(a, b, arrow)))).toEqual([
            [106, 50],
            [148, 50],
            [148, 70],
            [92, 70],
            [92, 90],
            [134, 90],
        ]);
    });

    test('rotated rect, diamond sector, and ellipse each match Excalidraw exactly', () => {
        const rotated = shapeEl({ id: 'D', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, angle: 30 });
        const rArrow = arrowEl({ points: '[[120,50],[400,400]]', startBinding: bind(rotated, [1, 0.5]) });
        expect(asPairs(elbowRoute(rArrow, byIdOf(rotated, rArrow)))).toEqual([
            [120, 50],
            [400, 50],
            [400, 400],
        ]);

        const diamond = shapeEl({ id: 'DI', type: 'diamond', x: 0, y: 0, width: 120, height: 80 });
        const dArrow = arrowEl({ points: '[[60,-6],[400,400]]', startBinding: bind(diamond, [0.5, -0.075]) });
        expect(asPairs(elbowRoute(dArrow, byIdOf(diamond, dArrow)))).toEqual([
            [60, -6],
            [60, -42],
            [400, -42],
            [400, 400],
        ]);

        const ellipse = shapeEl({ id: 'EL', type: 'ellipse', x: 0, y: 0, width: 100, height: 100 });
        const eArrow = arrowEl({ points: '[[106,50],[300,300]]', startBinding: bind(ellipse, [1.06, 0.5]) });
        expect(asPairs(elbowRoute(eArrow, byIdOf(ellipse, eArrow)))).toEqual([
            [106, 50],
            [300, 50],
            [300, 300],
        ]);
    });
});

// Reinder's binding invariant: the derived route MUST begin at the stored first point and end at the stored
// last point EXACTLY (arrow-local frame), for bound and unbound ends alike, so the endpoint dot (rendered at
// points[0]/points[last]) and the shaft's first/last vertex are one value — never offset from each other. The
// stored points are the truth; the route is derived from them and never rewrites them.
describe('elbowRoute — route endpoints equal the stored endpoints exactly', () => {
    const firstLast = (points: string): [Point, Point] => {
        const pts = JSON.parse(points) as [number, number][];
        return [
            { x: pts[0][0], y: pts[0][1] },
            { x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] },
        ];
    };

    test('unbound elbow with a nonzero arrow origin', () => {
        const arrow = arrowEl({ points: '[[0,0],[100,80]]', x: 37, y: -19 });
        const route = elbowRoute(arrow, byIdOf(arrow));
        const [first, last] = firstLast(arrow.points);
        expect(route[0]).toEqual(first);
        expect(route[route.length - 1]).toEqual(last);
    });

    test('bound both ends — route starts/ends on the stored points, not the fixedPoint', () => {
        const a = shapeEl({ id: 'A', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 });
        const b = shapeEl({ id: 'B', type: 'rectangle', x: 200, y: 200, width: 100, height: 100 });
        // Stored endpoints deliberately off the fixedPoint-derived dock (the 0.5001 nudge would move them).
        const arrow = arrowEl({
            points: '[[100,50],[250,200]]',
            x: 12,
            y: 7,
            startBinding: bind(a, [1, 0.5]),
            endBinding: bind(b, [0.5, 0]),
        });
        const route = elbowRoute(arrow, byIdOf(a, b, arrow));
        const [first, last] = firstLast(arrow.points);
        expect(route[0]).toEqual(first);
        expect(route[route.length - 1]).toEqual(last);
    });

    test('bound start on a ROTATED shape (the reported case) still starts on the stored point', () => {
        const rotated = shapeEl({ id: 'D', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, angle: 37 });
        const arrow = arrowEl({ points: '[[140,44],[400,300]]', x: 24, y: 55, startBinding: bind(rotated, [1, 0.5]) });
        const route = elbowRoute(arrow, byIdOf(rotated, arrow));
        const [first, last] = firstLast(arrow.points);
        expect(route[0]).toEqual(first);
        expect(route[route.length - 1]).toEqual(last);
    });
});
