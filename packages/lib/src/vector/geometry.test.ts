import { describe, expect, test } from 'bun:test';
import {
    type Box,
    boxCenter,
    getElementBounds,
    getElementsBounds,
    hitTestBox,
    hitTestDiamond,
    hitTestElement,
    hitTestEllipse,
    rotatePoint,
    unionBounds,
} from './geometry';
import { DEFAULT_ELEMENT_PROPS, type VectorElement } from './types';

const box = (over: Partial<Box>): Box => ({ x: 0, y: 0, width: 100, height: 60, angle: 0, ...over });

describe('rotatePoint', () => {
    test('rotates 90° clockwise about the origin (y-down)', () => {
        const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
        expect(p.x).toBeCloseTo(0);
        expect(p.y).toBeCloseTo(10);
    });

    test('rotating by 0 returns the same point', () => {
        expect(rotatePoint({ x: 3, y: 7 }, { x: 1, y: 1 }, 0)).toEqual({ x: 3, y: 7 });
    });
});

describe('getElementBounds', () => {
    test('unrotated box bounds are its own extents', () => {
        expect(getElementBounds(box({ x: 5, y: 8, width: 20, height: 10 }))).toEqual({
            minX: 5,
            minY: 8,
            maxX: 25,
            maxY: 18,
        });
    });

    test('rotation expands the axis-aligned bounds about the center', () => {
        const b = getElementBounds(box({ x: 0, y: 0, width: 100, height: 100, angle: 45 }));
        // 100×100 square rotated 45°: AABB centered at (50,50), half-extent 50√2
        const half = 50 * Math.SQRT2;
        expect(b.minX).toBeCloseTo(50 - half);
        expect(b.maxX).toBeCloseTo(50 + half);
        expect(b.minY).toBeCloseTo(50 - half);
        expect(b.maxY).toBeCloseTo(50 + half);
    });
});

describe('boxCenter', () => {
    test('is the box midpoint', () => {
        expect(boxCenter(box({ x: 10, y: 20, width: 40, height: 60 }))).toEqual({ x: 30, y: 50 });
    });
});

describe('unionBounds / getElementsBounds', () => {
    test('unionBounds spans both', () => {
        expect(unionBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { minX: 5, minY: -5, maxX: 20, maxY: 8 })).toEqual(
            { minX: 0, minY: -5, maxX: 20, maxY: 10 },
        );
    });

    test('getElementsBounds unions element bounds', () => {
        const b = getElementsBounds([
            box({ x: 0, y: 0, width: 10, height: 10 }),
            box({ x: 50, y: 50, width: 10, height: 10 }),
        ]);
        expect(b).toEqual({ minX: 0, minY: 0, maxX: 60, maxY: 60 });
    });
});

describe('hitTestBox', () => {
    test('inside vs outside an unrotated box', () => {
        const b = box({ x: 0, y: 0, width: 100, height: 20 });
        expect(hitTestBox(b, { x: 50, y: 10 })).toBe(true);
        expect(hitTestBox(b, { x: 50, y: 50 })).toBe(false);
    });

    test('rotation moves the hit region — probe is unrotated into local space', () => {
        const b = box({ x: 0, y: 0, width: 100, height: 20, angle: 90 });
        expect(hitTestBox(b, { x: 50, y: 50 })).toBe(true);
    });
});

describe('hitTestEllipse', () => {
    const b = box({ x: 0, y: 0, width: 100, height: 60 });
    test('center is inside, bbox corner is outside', () => {
        expect(hitTestEllipse(b, { x: 50, y: 30 })).toBe(true);
        expect(hitTestEllipse(b, { x: 0, y: 0 })).toBe(false);
    });
});

describe('hitTestDiamond', () => {
    const b = box({ x: 0, y: 0, width: 100, height: 60 });
    test('center inside, top vertex on boundary, bbox corner outside', () => {
        expect(hitTestDiamond(b, { x: 50, y: 30 })).toBe(true);
        expect(hitTestDiamond(b, { x: 50, y: 0 })).toBe(true);
        expect(hitTestDiamond(b, { x: 0, y: 0 })).toBe(false);
    });
});

describe('hitTestElement', () => {
    const make = (type: VectorElement['type']): VectorElement => {
        const base = {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'e',
            x: 0,
            y: 0,
            width: 100,
            height: 60,
            angle: 0,
            seed: 1,
            index: 'a0',
        };
        if (type === 'text')
            return { ...base, type, text: 'hi', fontSize: 20, fontFamily: 'Excalifont', textAlign: 'left' };
        if (type === 'image') return { ...base, type, mediaName: 'x.png' };
        return { ...base, type, roundness: 'sharp' };
    };

    test('dispatches shape geometry per type — corner hits a rectangle but not an ellipse', () => {
        expect(hitTestElement(make('rectangle'), { x: 0, y: 0 })).toBe(true);
        expect(hitTestElement(make('ellipse'), { x: 0, y: 0 })).toBe(false);
        expect(hitTestElement(make('diamond'), { x: 0, y: 0 })).toBe(false);
        expect(hitTestElement(make('text'), { x: 0, y: 0 })).toBe(true);
        expect(hitTestElement(make('image'), { x: 0, y: 0 })).toBe(true);
    });
});
