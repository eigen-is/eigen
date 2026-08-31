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
