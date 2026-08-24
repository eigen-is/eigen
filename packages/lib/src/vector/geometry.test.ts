import { describe, expect, test } from 'bun:test';
import {
    applyResize,
    type Box,
    boxCenter,
    getElementBounds,
    getElementsBounds,
    hitTestBox,
    hitTestDiamond,
    hitTestElement,
    hitTestEllipse,
    marqueeHits,
    marqueeMode,
    normalizeAngle,
    type Point,
    resizeRotatedRect,
    rotatePoint,
    snapAngle,
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

// World-space position of one corner of a (possibly rotated) box — the fixed-anchor invariant
// a rotated resize must preserve.
const worldCorner = (b: Box, corner: 'nw' | 'ne' | 'se' | 'sw'): Point => {
    const local: Point = {
        nw: { x: b.x, y: b.y },
        ne: { x: b.x + b.width, y: b.y },
        se: { x: b.x + b.width, y: b.y + b.height },
        sw: { x: b.x, y: b.y + b.height },
    }[corner];
    return rotatePoint(local, boxCenter(b), b.angle);
};

describe('applyResize', () => {
    test('se corner grows toward the drag, top-left stays pinned', () => {
        expect(applyResize('resize-se', 10, 10, box({}), { fromCenter: false, keepAspect: false }, 1)).toEqual({
            x: 0,
            y: 0,
            width: 110,
            height: 70,
            angle: 0,
        });
    });

    test('nw corner grows away from the pinned bottom-right, moving x/y', () => {
        expect(applyResize('resize-nw', 10, 10, box({}), { fromCenter: false, keepAspect: false }, 1)).toEqual({
            x: 10,
            y: 10,
            width: 90,
            height: 50,
            angle: 0,
        });
    });

    test('aspect-lock: the larger relative delta wins — x dominates, y is derived', () => {
        // 100×50 (ratio 2). dx=40 (0.4 rel) beats dy=5 (0.1 rel) → height follows width.
        expect(
            applyResize(
                'resize-se',
                40,
                5,
                box({ width: 100, height: 50 }),
                { fromCenter: false, keepAspect: true },
                1,
            ),
        ).toEqual({ x: 0, y: 0, width: 140, height: 70, angle: 0 });
    });

    test('aspect-lock: the larger relative delta wins — y dominates, x is derived', () => {
        expect(
            applyResize(
                'resize-se',
                5,
                40,
                box({ width: 100, height: 50 }),
                { fromCenter: false, keepAspect: true },
                1,
            ),
        ).toEqual({ x: 0, y: 0, width: 180, height: 90, angle: 0 });
    });

    test('from-center: both axes grow symmetrically and the center holds', () => {
        const next = applyResize('resize-se', 10, 10, box({}), { fromCenter: true, keepAspect: false }, 1);
        expect(next).toEqual({ x: -10, y: -10, width: 120, height: 80, angle: 0 });
        expect(boxCenter(next)).toEqual(boxCenter(box({})));
    });

    test('minSize clamps a shrink instead of flipping through zero', () => {
        // nw drag past the opposite corner: no mirror — both dims pin at minSize=30.
        expect(applyResize('resize-nw', 200, 200, box({}), { fromCenter: false, keepAspect: false }, 30)).toEqual({
            x: 70,
            y: 30,
            width: 30,
            height: 30,
            angle: 0,
        });
    });

    test('minSize clamp under aspect-lock rescales through one factor, preserving ratio', () => {
        // Collapse a 100×60 (ratio 5/3) below the floor: height pins at 30, width tracks the ratio.
        const next = applyResize('resize-se', -200, -200, box({}), { fromCenter: false, keepAspect: true }, 30);
        expect(next).toEqual({ x: 0, y: 0, width: 50, height: 30, angle: 0 });
        expect(next.width / next.height).toBeCloseTo(100 / 60);
    });
});

describe('resizeRotatedRect', () => {
    test('at angle 0 it is exactly applyResize', () => {
        const opts = { fromCenter: false, keepAspect: false };
        expect(resizeRotatedRect('resize-se', 10, 10, box({}), opts, 1)).toEqual(
            applyResize('resize-se', 10, 10, box({}), opts, 1),
        );
    });

    test('rotated resize keeps the opposite (anchor) corner fixed in world space', () => {
        const start = box({ angle: 90 });
        const before = worldCorner(start, 'nw'); // se-handle anchor is nw
        const next = resizeRotatedRect('resize-se', 0, 12, start, { fromCenter: false, keepAspect: false }, 1);
        const after = worldCorner(next, 'nw');
        expect(after.x).toBeCloseTo(before.x);
        expect(after.y).toBeCloseTo(before.y);
        expect(next.angle).toBe(90);
    });

    test('rotated from-center resize keeps the box center fixed', () => {
        const start = box({ angle: 30 });
        const next = resizeRotatedRect('resize-se', 20, 10, start, { fromCenter: true, keepAspect: false }, 1);
        expect(boxCenter(next).x).toBeCloseTo(boxCenter(start).x);
        expect(boxCenter(next).y).toBeCloseTo(boxCenter(start).y);
    });

    test('rotated aspect-lock resize preserves the width/height ratio', () => {
        const next = resizeRotatedRect(
            'resize-se',
            40,
            5,
            box({ width: 100, height: 50, angle: 45 }),
            {
                fromCenter: false,
                keepAspect: true,
            },
            1,
        );
        expect(next.width / next.height).toBeCloseTo(2);
    });
});

describe('snapAngle', () => {
    test('snaps to the nearest 15° by default', () => {
        expect(snapAngle(7)).toBe(0);
        expect(snapAngle(8)).toBe(15);
        expect(snapAngle(52)).toBe(45);
        expect(snapAngle(53)).toBe(60);
        expect(snapAngle(-8)).toBe(-15);
    });

    test('honors a custom step', () => {
        expect(snapAngle(50, 90)).toBe(90);
        expect(snapAngle(44, 90)).toBe(0);
    });
});

describe('normalizeAngle', () => {
    test('wraps into [0, 360)', () => {
        expect(normalizeAngle(0)).toBe(0);
        expect(normalizeAngle(360)).toBe(0);
        expect(normalizeAngle(370)).toBe(10);
        expect(normalizeAngle(720)).toBe(0);
        expect(normalizeAngle(-10)).toBe(350);
        expect(normalizeAngle(-370)).toBe(350);
    });
});

describe('marqueeMode', () => {
    test('rightward drag is contain, leftward is intersect', () => {
        expect(marqueeMode(10, 50)).toBe('contain');
        expect(marqueeMode(50, 10)).toBe('intersect');
    });

    test('zero-width drag ties to contain', () => {
        expect(marqueeMode(30, 30)).toBe('contain');
    });
});

describe('marqueeHits', () => {
    const marquee = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

    test('contain requires the full bounds inside, edges inclusive', () => {
        expect(marqueeHits({ minX: 10, minY: 10, maxX: 90, maxY: 90 }, marquee, 'contain')).toBe(true);
        expect(marqueeHits({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, marquee, 'contain')).toBe(true);
        expect(marqueeHits({ minX: 10, minY: 10, maxX: 101, maxY: 90 }, marquee, 'contain')).toBe(false);
    });

    test('intersect takes any strict overlap; edge-touching does not count', () => {
        expect(marqueeHits({ minX: 90, minY: 90, maxX: 150, maxY: 150 }, marquee, 'intersect')).toBe(true);
        expect(marqueeHits({ minX: 100, minY: 0, maxX: 150, maxY: 100 }, marquee, 'intersect')).toBe(false);
        expect(marqueeHits({ minX: 120, minY: 120, maxX: 150, maxY: 150 }, marquee, 'intersect')).toBe(false);
    });

    test('a contained box also intersects', () => {
        expect(marqueeHits({ minX: 10, minY: 10, maxX: 90, maxY: 90 }, marquee, 'intersect')).toBe(true);
    });
});
