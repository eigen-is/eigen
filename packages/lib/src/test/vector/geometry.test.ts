import { describe, expect, test } from 'bun:test';
import {
    applyResize,
    type Box,
    boxCenter,
    distanceToPolyline,
    getElementBounds,
    getElementsBounds,
    hitTestBox,
    hitTestDiamond,
    hitTestElement,
    hitTestEllipse,
    isClosedPath,
    marqueeHits,
    marqueeMode,
    normalizeAngle,
    normalizeLinear,
    type Point,
    parsePoints,
    rescalePoints,
    resizeLinear,
    resizeRotatedRect,
    rotatePoint,
    serializePoints,
    snapAngle,
    unionBounds,
} from '../../vector/geometry';
import { DEFAULT_ELEMENT_PROPS, type VectorElement, type VectorLinearElement } from '../../vector/types';

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
    const make = (type: 'rectangle' | 'diamond' | 'ellipse' | 'text' | 'image'): VectorElement => {
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
        // Shapes ignore the outline threshold (inside/outline behaviour unchanged); pass 0.
        expect(hitTestElement(make('rectangle'), { x: 0, y: 0 }, 0)).toBe(true);
        expect(hitTestElement(make('ellipse'), { x: 0, y: 0 }, 0)).toBe(false);
        expect(hitTestElement(make('diamond'), { x: 0, y: 0 }, 0)).toBe(false);
        expect(hitTestElement(make('text'), { x: 0, y: 0 }, 0)).toBe(true);
        expect(hitTestElement(make('image'), { x: 0, y: 0 }, 0)).toBe(true);
    });
});

// --- Linear elements: parse/serialize, normalize, rescale, distance, closed-path, hit-testing ------

const linear = (over: Partial<VectorLinearElement> & { points: string }): VectorLinearElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    id: 'l',
    type: 'line',
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    seed: 1,
    index: 'a0',
    roundness: 'sharp',
    ...over,
});

describe('parsePoints / serializePoints', () => {
    test('round-trips a point list and rounds to 2 decimals', () => {
        expect(
            serializePoints([
                { x: 0, y: 0 },
                { x: 1.239, y: -2.641 },
            ]),
        ).toBe('[[0,0],[1.24,-2.64]]');
        expect(parsePoints('[[0,0],[1.24,-2.64]]')).toEqual([
            { x: 0, y: 0 },
            { x: 1.24, y: -2.64 },
        ]);
    });

    test('normalizes -0 to 0 on serialize', () => {
        expect(serializePoints([{ x: -0, y: -0.001 }])).toBe('[[0,0]]');
    });

    test('returns [] on garbage — bad JSON, non-array, short pair, or non-finite coord', () => {
        expect(parsePoints('not json')).toEqual([]);
        expect(parsePoints('{}')).toEqual([]);
        expect(parsePoints('[[0]]')).toEqual([]);
        expect(parsePoints('[[0,"x"]]')).toEqual([]);
        expect(parsePoints('[[0,null]]')).toEqual([]);
        expect(parsePoints('[]')).toEqual([]);
    });
});

// The scene position of a stored local point p under the renderer's transform:
// translate(x,y) then rotate(angle) about the box centre (w/2, h/2).
const sceneOf = (n: { x: number; y: number; width: number; height: number }, angle: number, p: Point): Point => {
    const center = { x: n.width / 2, y: n.height / 2 };
    const rotated = rotatePoint(p, center, angle);
    return { x: n.x + rotated.x, y: n.y + rotated.y };
};

describe('normalizeLinear', () => {
    test('moves the bbox min corner to the origin and shifts x/y (angle 0)', () => {
        const n = normalizeLinear({
            x: 10,
            y: 20,
            angle: 0,
            points: [
                { x: 5, y: 5 },
                { x: 15, y: 25 },
            ],
        });
        expect(n).toEqual({ x: 15, y: 25, width: 10, height: 20, points: '[[0,0],[10,20]]' });
    });

    test('negative-going points normalize to a non-negative set; width/height span the raw bbox', () => {
        const n = normalizeLinear({
            x: 0,
            y: 0,
            angle: 0,
            points: [
                { x: 0, y: 0 },
                { x: -30, y: 10 },
                { x: 20, y: -5 },
            ],
        });
        expect(n.width).toBe(50);
        expect(n.height).toBe(15);
        // min corner (-30,-5) → origin: every coordinate is now ≥ 0, and x/y absorb the shift.
        expect(n.points).toBe('[[30,5],[0,15],[50,0]]');
        expect(n).toMatchObject({ x: -30, y: -5 });
    });

    test('the scene position of every point is preserved, with and without angle', () => {
        const raw = [
            { x: 0, y: 0 },
            { x: -30, y: 10 },
            { x: 20, y: -5 },
            { x: 8, y: 40 },
        ];
        for (const angle of [0, 37, 90, 210]) {
            const n = normalizeLinear({ x: 100, y: 60, angle, points: raw });
            const shifted: Point[] = JSON.parse(n.points).map(([x, y]: [number, number]) => ({ x, y }));
            // Each normalized point maps to the same scene position the raw point had before normalizing.
            const rawBox = { x: 100, y: 60, width: n.width, height: n.height };
            for (let i = 0; i < raw.length; i++) {
                const before = sceneOf(rawBox, angle, raw[i]);
                const after = sceneOf(n, angle, shifted[i]);
                expect(after.x).toBeCloseTo(before.x);
                expect(after.y).toBeCloseTo(before.y);
            }
        }
    });

    test('an empty point list is a no-op box at the current position', () => {
        expect(normalizeLinear({ x: 7, y: 8, angle: 0, points: [] })).toEqual({
            x: 7,
            y: 8,
            width: 0,
            height: 0,
            points: '[]',
        });
    });
});

describe('rescalePoints', () => {
    test('scales per axis about the origin point', () => {
        const scaled = rescalePoints(
            [
                { x: 0, y: 0 },
                { x: 50, y: 20 },
            ],
            { width: 50, height: 20 },
            { width: 100, height: 10 },
        );
        expect(scaled).toEqual([
            { x: 0, y: 0 },
            { x: 100, y: 10 },
        ]);
    });

    test('a degenerate old dimension keeps that axis (nothing to scale from)', () => {
        const scaled = rescalePoints(
            [
                { x: 0, y: 0 },
                { x: 40, y: 0 },
            ],
            { width: 40, height: 0 },
            { width: 80, height: 30 },
        );
        expect(scaled).toEqual([
            { x: 0, y: 0 },
            { x: 80, y: 0 },
        ]);
    });
});

describe('resizeLinear', () => {
    test('rescales points to the new box per axis and keeps points[0] the origin', () => {
        const el = linear({ points: '[[0,0],[50,20]]', width: 50, height: 20, x: 10, y: 10 });
        const r = resizeLinear(el, { x: 10, y: 10, width: 100, height: 10, angle: 0 });
        expect(r).toEqual({ x: 10, y: 10, width: 100, height: 10, points: '[[0,0],[100,10]]' });
    });

    test('a degenerate source axis is preserved (a flat line stays flat when grown vertically)', () => {
        const el = linear({ points: '[[0,0],[40,0]]', width: 40, height: 0, x: 0, y: 0 });
        const r = resizeLinear(el, { x: 5, y: 5, width: 80, height: 30, angle: 0 });
        expect(r).toMatchObject({ x: 5, y: 5, width: 80, height: 0, points: '[[0,0],[80,0]]' });
    });
});

describe('distanceToPolyline', () => {
    test('is zero on a vertex and measures perpendicular to a segment', () => {
        const poly = [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
        ];
        expect(distanceToPolyline(poly, { x: 50, y: 0 })).toBe(0);
        expect(distanceToPolyline(poly, { x: 50, y: 7 })).toBe(7);
        // beyond the segment end clamps to the endpoint
        expect(distanceToPolyline(poly, { x: 130, y: 0 })).toBe(30);
    });

    test('a single point degrades to point distance; an empty path is unreachable', () => {
        expect(distanceToPolyline([{ x: 3, y: 4 }], { x: 0, y: 0 })).toBe(5);
        expect(distanceToPolyline([], { x: 0, y: 0 })).toBe(Number.POSITIVE_INFINITY);
    });
});

describe('isClosedPath', () => {
    test('needs at least 3 points with the ends within 8 units', () => {
        expect(
            isClosedPath([
                { x: 0, y: 0 },
                { x: 50, y: 0 },
            ]),
        ).toBe(false);
        expect(
            isClosedPath([
                { x: 0, y: 0 },
                { x: 50, y: 0 },
                { x: 25, y: 40 },
                { x: 3, y: 2 },
            ]),
        ).toBe(true);
        expect(
            isClosedPath([
                { x: 0, y: 0 },
                { x: 50, y: 0 },
                { x: 25, y: 40 },
                { x: 20, y: 5 },
            ]),
        ).toBe(false);
    });
});

describe('hitTestElement — linear', () => {
    test('an open line is hit within threshold + half the stroke, unrotated', () => {
        const el = linear({ points: '[[0,0],[100,40]]', strokeWidth: 4, width: 100, height: 40 });
        // on the segment midpoint (scene = x/y + local since angle 0)
        expect(hitTestElement(el, { x: 50, y: 20 }, 2)).toBe(true);
        // just off the line but inside threshold(2) + strokeWidth/2(2) = 4 of the segment
        expect(hitTestElement(el, { x: 50, y: 20 }, 2)).toBe(true);
        // far from the segment: miss
        expect(hitTestElement(el, { x: 50, y: 60 }, 2)).toBe(false);
    });

    test('a rotated line unrotates the probe about the box center before measuring', () => {
        const el = linear({ points: '[[0,0],[100,0]]', width: 100, height: 0, angle: 90, x: 0, y: 0 });
        // box center = (50, 0); a horizontal line rotated 90° cw about it runs vertically through x=50.
        expect(hitTestElement(el, { x: 50, y: -50 }, 3)).toBe(true);
        expect(hitTestElement(el, { x: 90, y: 0 }, 3)).toBe(false);
    });

    test('freedraw widens tolerance by half the fat ink width', () => {
        // thin freedraw: diameter 1 * 2.125; half = ~1.06, so within threshold(1) + 1.06 ≈ 2.06 of the line.
        const el = linear({ type: 'freedraw', points: '[[0,0],[100,0]]', strokeWidth: 1, width: 100, height: 0 });
        expect(hitTestElement(el, { x: 50, y: 2 }, 1)).toBe(true);
        expect(hitTestElement(el, { x: 50, y: 3 }, 1)).toBe(false);
    });

    test('a closed, filled line is hit inside the polygon; transparent is outline-only', () => {
        const points = '[[0,0],[100,0],[50,80],[0,0]]';
        const filled = linear({ points, backgroundColor: '#ff0000', width: 100, height: 80 });
        const open = linear({ points, backgroundColor: 'transparent', width: 100, height: 80 });
        expect(hitTestElement(filled, { x: 50, y: 30 }, 1)).toBe(true);
        expect(hitTestElement(open, { x: 50, y: 30 }, 1)).toBe(false);
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
