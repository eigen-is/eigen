import { describe, expect, test } from 'bun:test';
import {
    anchorToScene,
    applyResize,
    arrowheadGeometry,
    arrowLabelBox,
    type Box,
    bindingAnchor,
    bindingDistance,
    bindingGap,
    boundEndpoint,
    boxCenter,
    distanceToPolyline,
    elementBounds,
    followBindings,
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
    outlinePoint,
    type Point,
    parsePoints,
    remapBinding,
    rescalePoints,
    resizeLinear,
    resizeRotatedRect,
    rotatePoint,
    serializePoints,
    snapAngle,
    unionBounds,
} from '../../vector/geometry';
import {
    arrowsBoundTo,
    DEFAULT_ELEMENT_PROPS,
    serializeBinding,
    type VectorArrowElement,
    type VectorElement,
    type VectorLinearElement,
    type VectorShapeElement,
} from '../../vector/types';

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

    test('returns [] on garbage — bad JSON, non-array, short pair, or non-number coord', () => {
        expect(parsePoints('not json')).toEqual([]);
        expect(parsePoints('{}')).toEqual([]);
        expect(parsePoints('[[0]]')).toEqual([]);
        expect(parsePoints('[[0,"x"]]')).toEqual([]);
        expect(parsePoints('[[0,null]]')).toEqual([]);
        expect(parsePoints('[]')).toEqual([]);
    });

    test('drops a non-finite point (1e400 → Infinity) but keeps the rest of the stroke', () => {
        expect(parsePoints('[[0,0],[1e400,0],[10,10]]')).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 10 },
        ]);
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
        const n = normalizeLinear(box({ x: 10, y: 20 }), [
            { x: 5, y: 5 },
            { x: 15, y: 25 },
        ]);
        expect(n).toEqual({ x: 15, y: 25, width: 10, height: 20, points: '[[0,0],[10,20]]' });
    });

    test('negative-going points normalize to a non-negative set; width/height span the raw bbox', () => {
        const n = normalizeLinear(box({ width: 0, height: 0 }), [
            { x: 0, y: 0 },
            { x: -30, y: 10 },
            { x: 20, y: -5 },
        ]);
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
        // The current box has a DIFFERENT extent than the raw points — the rotation pivot moves.
        const current = { x: 100, y: 60, width: 20, height: 30 };
        for (const angle of [0, 37, 90, 210]) {
            const n = normalizeLinear({ ...current, angle }, raw);
            const shifted: Point[] = JSON.parse(n.points).map(([x, y]: [number, number]) => ({ x, y }));
            // Each normalized point maps to the same scene position the raw point had before normalizing.
            for (let i = 0; i < raw.length; i++) {
                const before = sceneOf(current, angle, raw[i]);
                const after = sceneOf(n, angle, shifted[i]);
                expect(after.x).toBeCloseTo(before.x);
                expect(after.y).toBeCloseTo(before.y);
            }
        }
    });

    test('dragging one vertex of a rotated line leaves the other vertex where it was', () => {
        const line = { x: 0, y: 0, width: 100, height: 0, angle: 90 };
        const start = { x: 0, y: 0 };
        const n = normalizeLinear(line, [start, { x: 100, y: 50 }]);
        expect(n).toMatchObject({ width: 100, height: 50, points: '[[0,0],[100,50]]' });
        const before = sceneOf(line, 90, start);
        const after = sceneOf(n, 90, start);
        expect(after.x).toBeCloseTo(before.x);
        expect(after.y).toBeCloseTo(before.y);
    });

    test('an empty point list is a no-op box at the current position', () => {
        expect(normalizeLinear(box({ x: 7, y: 8 }), [])).toEqual({ x: 7, y: 8, width: 0, height: 0, points: '[]' });
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
    test('rescales points to the new box per axis and keeps the min corner the origin', () => {
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

// --- Arrows: bindings, endpoints, heads, labels ---------------------------------------

const shapeEl = (over: Partial<VectorShapeElement> & Pick<VectorShapeElement, 'id' | 'type'>): VectorShapeElement => ({
    ...DEFAULT_ELEMENT_PROPS,
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

describe('bindingGap', () => {
    test('is 5 + half the stroke width', () => {
        expect(bindingGap(shapeEl({ id: 's', type: 'rectangle', strokeWidth: 2 }))).toBe(6);
        expect(bindingGap(shapeEl({ id: 's', type: 'rectangle', strokeWidth: 8 }))).toBe(9);
    });
});

describe('bindingAnchor / anchorToScene', () => {
    test('a scene point round-trips to its ratio and back, unrotated', () => {
        const shape = shapeEl({ id: 's', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 });
        expect(bindingAnchor(shape, { x: 50, y: 30 })).toEqual([0.5, 0.5]);
        expect(anchorToScene(shape, [0.5, 0.5])).toEqual({ x: 50, y: 30 });
    });

    test('the ratio ignores rotation (unrotate on write, rotate on read) — round-trips on a rotated shape', () => {
        const shape = shapeEl({ id: 's', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, angle: 90 });
        const p = anchorToScene(shape, [0.75, 0.25]);
        const [fx, fy] = bindingAnchor(shape, p);
        expect(fx).toBeCloseTo(0.75);
        expect(fy).toBeCloseTo(0.25);
    });

    test('anchorToScene clamps a ratio pushed outside [0,1] by a shrunk shape', () => {
        const shape = shapeEl({ id: 's', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 });
        expect(anchorToScene(shape, [1.5, -0.4])).toEqual({ x: 100, y: 0 });
    });

    test('a near-zero dimension divides by the gap, not zero (no Infinity)', () => {
        const shape = shapeEl({ id: 's', type: 'rectangle', x: 0, y: 0, width: 0, height: 60, strokeWidth: 2 });
        const [fx] = bindingAnchor(shape, { x: 3, y: 30 });
        expect(Number.isFinite(fx)).toBe(true);
        expect(fx).toBeCloseTo(3 / 6);
    });
});

describe('outlinePoint', () => {
    const from = { x: -100, y: 30 };
    const anchor = { x: 50, y: 30 };

    test('rectangle: the inflated side nearest `from` (sharp corners, gap = 6)', () => {
        const rect = shapeEl({ id: 's', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, strokeWidth: 2 });
        const p = outlinePoint(rect, from, anchor, bindingGap(rect));
        expect(p.x).toBeCloseTo(-6);
        expect(p.y).toBeCloseTo(30);
    });

    test('ellipse: the radius + gap crossing nearest `from`', () => {
        const ell = shapeEl({ id: 's', type: 'ellipse', x: 0, y: 0, width: 100, height: 60, strokeWidth: 2 });
        const p = outlinePoint(ell, from, anchor, bindingGap(ell));
        expect(p.x).toBeCloseTo(-6);
        expect(p.y).toBeCloseTo(30);
    });

    test('diamond: the inflated edge crossing (a vertical ray hits the bottom vertex)', () => {
        const dia = shapeEl({ id: 's', type: 'diamond', x: 0, y: 0, width: 100, height: 60, strokeWidth: 2 });
        const p = outlinePoint(dia, { x: 50, y: 200 }, { x: 50, y: 30 }, bindingGap(dia));
        // bInf = 30 + gap*hypot(50,30)/50 = 36.997, bottom vertex at (50, 30 + bInf)
        expect(p.x).toBeCloseTo(50);
        expect(p.y).toBeCloseTo(66.997, 2);
    });

    test('rotation is transparent: a square shape rotated 90° gives the same hit as unrotated', () => {
        for (const type of ['rectangle', 'ellipse', 'diamond'] as const) {
            const flat = shapeEl({ id: 's', type, x: 0, y: 0, width: 60, height: 60, strokeWidth: 2 });
            const turned = { ...flat, angle: 90 };
            const a = outlinePoint(flat, { x: -100, y: 30 }, { x: 30, y: 30 }, bindingGap(flat));
            const b = outlinePoint(turned, { x: -100, y: 30 }, { x: 30, y: 30 }, bindingGap(turned));
            expect(b.x).toBeCloseTo(a.x);
            expect(b.y).toBeCloseTo(a.y);
        }
    });
});

describe('boundEndpoint', () => {
    // A rectangle to the right of the arrow; its left inflated side sits at x = 5 - gap(6) = -1.
    const shape = shapeEl({ id: 'rect', type: 'rectangle', x: 5, y: -20, width: 40, height: 40, strokeWidth: 2 });

    test('snaps the endpoint to the shape outline along the segment from the other end', () => {
        const arrow = arrowEl({
            points: '[[0,0],[36,0]]',
            x: -30,
            y: 0,
            width: 36,
            endBinding: bind(shape, [0.5, 0.5]),
        });
        const p = boundEndpoint(arrow, 'end', shape);
        expect(p.x).toBeCloseTo(-1);
        expect(p.y).toBeCloseTo(0);
    });

    test('short-arrow guard: within 10 units of the other end it returns the anchor, not the outline', () => {
        // other end at (-3,0), outline point (-1,0) is 2 units away (< 10) → the anchor (25,0) wins.
        const arrow = arrowEl({
            points: '[[0,0],[9,0]]',
            x: -3,
            y: 0,
            width: 9,
            endBinding: bind(shape, [0.5, 0.5]),
        });
        expect(boundEndpoint(arrow, 'end', shape)).toEqual({ x: 25, y: 0 });
    });
});

describe('followBindings', () => {
    const shapeB = shapeEl({ id: 'rect', type: 'rectangle', x: 150, y: -30, width: 60, height: 60, strokeWidth: 2 });
    const byId = new Map<string, VectorElement>([[shapeB.id, shapeB]]);

    test('returns null when the arrow binds nothing', () => {
        expect(followBindings(arrowEl({ points: '[[0,0],[100,0]]' }), byId)).toBeNull();
    });

    test('recomputes a bound endpoint onto the current shape outline and re-normalizes', () => {
        const arrow = arrowEl({ points: '[[0,0],[100,0]]', width: 100, endBinding: bind(shapeB, [0, 0.5]) });
        const next = followBindings(arrow, byId);
        // shapeB's left inflated side is at 150 - gap(6) = 144; the start (unbound) stays at 0.
        expect(next).toEqual({ x: 0, y: 0, width: 144, height: 0, points: '[[0,0],[144,0]]' });
    });

    test('returns null when the endpoint already sits on the outline (idempotent)', () => {
        const settled = arrowEl({ points: '[[0,0],[144,0]]', width: 144, endBinding: bind(shapeB, [0, 0.5]) });
        expect(followBindings(settled, byId)).toBeNull();
    });

    test('a non-bindable or missing target is treated as unbound', () => {
        const arrow = arrowEl({ points: '[[0,0],[100,0]]', endBinding: bind({ ...shapeB, id: 'ghost' }, [0, 0.5]) });
        expect(followBindings(arrow, byId)).toBeNull();
    });

    test('rotated arrow: the bound start moves, the untouched vertices hold their scene position', () => {
        const arrow = arrowEl({
            points: '[[0,0],[50,20],[100,0]]',
            x: 0,
            y: 0,
            width: 100,
            height: 20,
            angle: 90,
            startBinding: bind(shapeB, [0, 0.5]),
        });
        const endBefore = sceneOf({ x: 0, y: 0, width: 100, height: 20 }, 90, { x: 100, y: 0 });
        const midBefore = sceneOf({ x: 0, y: 0, width: 100, height: 20 }, 90, { x: 50, y: 20 });
        const next = followBindings(arrow, byId);
        expect(next).not.toBeNull();
        if (!next) return;
        const pts: Point[] = JSON.parse(next.points).map(([x, y]: [number, number]) => ({ x, y }));
        const endAfter = sceneOf(next, 90, pts[2]);
        const midAfter = sceneOf(next, 90, pts[1]);
        expect(endAfter.x).toBeCloseTo(endBefore.x);
        expect(endAfter.y).toBeCloseTo(endBefore.y);
        expect(midAfter.x).toBeCloseTo(midBefore.x);
        expect(midAfter.y).toBeCloseTo(midBefore.y);
    });
});

describe('bindingDistance', () => {
    test('15 scene units at zoom ≥ 1, growing to 30 when zoomed far out', () => {
        expect(bindingDistance(1)).toBe(15);
        expect(bindingDistance(2)).toBe(15);
        expect(bindingDistance(0.5)).toBe(20);
        expect(bindingDistance(0.1)).toBe(30);
    });
});

describe('remapBinding', () => {
    const shape = shapeEl({ id: 'old', type: 'rectangle' });
    test('rewrites the target id through the map, preserving the fixedPoint', () => {
        const mapped = remapBinding(bind(shape, [0.25, 0.75]), new Map([['old', 'new']]));
        expect(mapped).toBe(serializeBinding({ elementId: 'new', fixedPoint: [0.25, 0.75] }));
    });

    test('a target outside the map clears the binding', () => {
        expect(remapBinding(bind(shape, [0.5, 0.5]), new Map([['other', 'x']]))).toBe('');
    });

    test('an empty binding stays empty', () => {
        expect(remapBinding('', new Map([['old', 'new']]))).toBe('');
    });
});

describe('arrowsBoundTo', () => {
    test('indexes shape id → the arrows bound to it, listing a both-ends arrow once', () => {
        const s1 = shapeEl({ id: 's1', type: 'rectangle' });
        const s2 = shapeEl({ id: 's2', type: 'ellipse' });
        const a1 = arrowEl({ points: '[[0,0],[10,0]]', startBinding: bind(s1, [0, 0]), endBinding: bind(s2, [1, 1]) });
        const a2 = arrowEl({
            points: '[[0,0],[10,0]]',
            startBinding: bind(s1, [0, 0]),
            endBinding: bind(s1, [1, 1]),
        });
        const map = arrowsBoundTo([s1, s2, { ...a1, id: 'a1' }, { ...a2, id: 'a2' }]);
        expect(map.get('s1')).toEqual(['a1', 'a2']);
        expect(map.get('s2')).toEqual(['a1']);
    });
});

describe('arrowheadGeometry', () => {
    const arrow = arrowEl({ points: '[[0,0],[100,0]]', strokeWidth: 2 });

    test('none / too-few points yield no head', () => {
        expect(arrowheadGeometry(arrow, parsePoints(arrow.points), 'end', 'none')).toBeNull();
        expect(arrowheadGeometry(arrow, [{ x: 0, y: 0 }], 'end', 'arrow')).toBeNull();
    });

    test('arrow: barbs meet at the tip, symmetric about the segment, sized to 25', () => {
        const geo = arrowheadGeometry(arrow, parsePoints(arrow.points), 'end', 'arrow');
        expect(geo?.kind).toBe('barbs');
        if (geo?.kind !== 'barbs') return;
        expect(geo.tip).toEqual({ x: 100, y: 0 });
        // barbs are the base point (tip - 25) rotated ±20° about the tip → symmetric in y
        expect(geo.barb1.x).toBeCloseTo(geo.barb2.x);
        expect(geo.barb1.y).toBeCloseTo(-geo.barb2.y);
        expect(Math.hypot(geo.barb1.x - 100, geo.barb1.y)).toBeCloseTo(25);
    });

    test('the head shrinks to half a short segment instead of overrunning it', () => {
        const short = arrowEl({ points: '[[0,0],[10,0]]' });
        const geo = arrowheadGeometry(short, parsePoints(short.points), 'end', 'arrow');
        if (geo?.kind !== 'barbs') throw new Error('expected barbs');
        expect(Math.hypot(geo.barb1.x - 10, geo.barb1.y)).toBeCloseTo(5);
    });

    test('bar: a line through the tip perpendicular to the segment', () => {
        const geo = arrowheadGeometry(arrow, parsePoints(arrow.points), 'end', 'bar');
        if (geo?.kind !== 'barbs') throw new Error('expected barbs');
        expect(geo.barb1).toEqual({ x: 100, y: 15 });
        expect(geo.barb2).toEqual({ x: 100, y: -15 });
    });

    test('circle: centered on the tip, diameter from the head span + strokeWidth − 2', () => {
        const geo = arrowheadGeometry(arrow, parsePoints(arrow.points), 'end', 'circle');
        expect(geo).toEqual({ kind: 'circle', center: { x: 100, y: 0 }, diameter: 15 });
    });

    test('circle: the diameter stays positive for a thin, short arrow', () => {
        const tiny = arrowEl({ points: '[[0,0],[2,0]]', strokeWidth: 1 });
        const geo = arrowheadGeometry(tiny, parsePoints(tiny.points), 'end', 'circle');
        expect(geo).toEqual({ kind: 'circle', center: { x: 2, y: 0 }, diameter: 1 });
    });

    test('start head reads the first segment', () => {
        const geo = arrowheadGeometry(arrow, parsePoints(arrow.points), 'start', 'triangle');
        if (geo?.kind !== 'barbs') throw new Error('expected barbs');
        expect(geo.tip).toEqual({ x: 0, y: 0 });
        expect(geo.barb1.x).toBeGreaterThan(0);
    });
});

describe('arrowLabelBox', () => {
    test('no label when text is empty or the arrow is degenerate', () => {
        expect(arrowLabelBox(arrowEl({ points: '[[0,0],[100,0]]' }))).toBeNull();
        expect(arrowLabelBox(arrowEl({ points: '[[0,0]]', text: 'x' }))).toBeNull();
    });

    test('even point count centers on the middle segment midpoint; height = lines × line height', () => {
        const el = arrowEl({ points: '[[0,0],[100,0]]', text: 'one\ntwo', labelWidth: 40 });
        expect(arrowLabelBox(el)).toEqual({ center: { x: 50, y: 0 }, width: 40, height: 50 });
    });

    test('odd point count centers on the middle vertex', () => {
        const el = arrowEl({ points: '[[0,0],[50,50],[100,0]]', text: 'hi', labelWidth: 20 });
        expect(arrowLabelBox(el)).toEqual({ center: { x: 50, y: 50 }, width: 20, height: 25 });
    });
});

describe('elementBounds', () => {
    test('a plain arrow is its own box AABB', () => {
        const el = arrowEl({ points: '[[0,0],[100,0]]', width: 100, height: 0 });
        expect(elementBounds(el)).toEqual(getElementBounds(el));
    });

    test('a wide label unions its rect into the bounds', () => {
        const el = arrowEl({ points: '[[0,0],[100,0]]', width: 100, height: 0, text: 'wide', labelWidth: 200 });
        const b = elementBounds(el);
        // label rect: center (50,0), 200 wide, 25 tall → x −50..150, y −12.5..12.5
        expect(b.minX).toBeCloseTo(-50);
        expect(b.maxX).toBeCloseTo(150);
        expect(b.minY).toBeCloseTo(-12.5);
        expect(b.maxY).toBeCloseTo(12.5);
    });
});

describe('hitTestElement — arrow', () => {
    test('hit on the shaft and inside the label rect, missed elsewhere', () => {
        const el = arrowEl({
            points: '[[0,0],[100,0]]',
            width: 100,
            height: 0,
            strokeWidth: 4,
            text: 'lbl',
            labelWidth: 40,
        });
        // on the shaft
        expect(hitTestElement(el, { x: 50, y: 0 }, 2)).toBe(true);
        // off the shaft but inside the label rect (center 50,0; 40×25)
        expect(hitTestElement(el, { x: 50, y: 10 }, 1)).toBe(true);
        // clear of both
        expect(hitTestElement(el, { x: 50, y: 40 }, 1)).toBe(false);
    });
});
