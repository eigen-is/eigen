import { describe, expect, test } from 'bun:test';
import { RoughGenerator } from 'roughjs/bin/generator';
import { elbowRoute } from '../../vector/elbow-route';
import { solidFill } from '../../vector/fill';
import {
    anchorToScene,
    applyResize,
    arrowCurveBeziers,
    arrowheadGeometry,
    arrowLabelBox,
    type Box,
    bindingAnchor,
    bindingDistance,
    bindingGap,
    boundEndpoint,
    boxCenter,
    COARSE_HIT_SLOP_MULTIPLIER,
    distanceToPolyline,
    elbowAnchorScene,
    elementBounds,
    focusSnapPoint,
    followBindings,
    getElementBounds,
    getElementsBounds,
    HIT_THRESHOLD_SCREEN,
    hitTestBox,
    hitTestDiamond,
    hitTestElement,
    hitTestEllipse,
    hitThresholdScreen,
    isClosedPath,
    linearLocalToScene,
    linearSceneToLocal,
    marqueeHits,
    marqueeMode,
    normalizeAngle,
    normalizeFixedPoint,
    normalizeLinear,
    outlinePoint,
    type Point,
    parsePoints,
    projectFixedPointOntoDiagonal,
    remapBinding,
    rescalePoints,
    resizeLinear,
    resizeRotatedRect,
    rotatePoint,
    serializePoints,
    shapeAnchorPoints,
    snapAngle,
    unionBounds,
} from '../../vector/geometry';
import {
    arrowsBoundTo,
    type Corners,
    DEFAULT_ELEMENT_PROPS,
    serializeBinding,
    type VectorArrowElement,
    type VectorBindableElement,
    type VectorElement,
    type VectorLinearElement,
    type VectorRectangleElement,
    type VectorRichTextElement,
    type VectorShapeElement,
} from '../../vector/types';
import { richtext } from './element-factories';

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
    const make = (type: 'rectangle' | 'diamond' | 'ellipse' | 'richtext' | 'image'): VectorElement => {
        const base = {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'e',
            x: 0,
            y: 0,
            width: 100,
            height: 60,
            angle: 0,
            index: 'a0',
            fill: solidFill('transparent'),
            corners: 'straight',
        } satisfies Omit<VectorRectangleElement, 'type' | 'roughness' | 'seed'>;
        if (type === 'richtext')
            return {
                ...base,
                type,
                html: '<p>hi</p>',
                fontFamily: 'Excalifont',
                fontSize: 20,
                fontWeight: 'normal',
                fontStyle: 'normal',
                textDecoration: 'none',
                textAlign: 'left',
                verticalAlign: 'top',
                color: '#1e1e1e',
                letterSpacing: 0,
                lineHeight: 1.2,
                padding: 0,
            };
        if (type === 'image') return { ...base, type, mediaName: 'x.png', objectFit: 'contain' };
        return { ...base, type, roughness: 1, seed: 1 };
    };

    test('dispatches shape geometry per type — corner hits a rectangle but not an ellipse', () => {
        // Shapes ignore the outline threshold (inside/outline behaviour unchanged); pass 0.
        expect(hitTestElement(make('rectangle'), { x: 0, y: 0 }, 0)).toBe(true);
        expect(hitTestElement(make('ellipse'), { x: 0, y: 0 }, 0)).toBe(false);
        expect(hitTestElement(make('diamond'), { x: 0, y: 0 }, 0)).toBe(false);
        expect(hitTestElement(make('richtext'), { x: 0, y: 0 }, 0)).toBe(true);
        expect(hitTestElement(make('image'), { x: 0, y: 0 }, 0)).toBe(true);
    });
});

// --- Linear elements: parse/serialize, normalize, rescale, distance, closed-path, hit-testing ------

const linear = (over: Partial<VectorLinearElement> & { points: string }): VectorLinearElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    id: 'l',
    type: 'line',
    fill: solidFill('transparent'),
    roughness: 1,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    seed: 1,
    index: 'a0',
    roundness: 'sharp',
    pressures: '',
    simulatePressure: true,
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
    test('an open line is hit within max(0.85·threshold, strokeWidth/2 + 0.1), unrotated', () => {
        const el = linear({ points: '[[0,0],[100,0]]', strokeWidth: 4, width: 100, height: 0 });
        // wide threshold arm dominates: 0.85·10 = 8.5
        expect(hitTestElement(el, { x: 50, y: 8 }, 10)).toBe(true);
        expect(hitTestElement(el, { x: 50, y: 9 }, 10)).toBe(false);
        // ink arm dominates at low threshold: strokeWidth/2 + 0.1 = 2.1 (0.85·1 = 0.85 loses)
        expect(hitTestElement(el, { x: 50, y: 2 }, 1)).toBe(true);
        expect(hitTestElement(el, { x: 50, y: 2.2 }, 1)).toBe(false);
    });

    test('a rotated line unrotates the probe about the box center before measuring', () => {
        const el = linear({ points: '[[0,0],[100,0]]', width: 100, height: 0, angle: 90, x: 0, y: 0 });
        // box center = (50, 0); a horizontal line rotated 90° cw about it runs vertically through x=50.
        expect(hitTestElement(el, { x: 50, y: -50 }, 3)).toBe(true);
        expect(hitTestElement(el, { x: 90, y: 0 }, 3)).toBe(false);
    });

    test('freedraw widens tolerance by half the fat ink width', () => {
        // thin freedraw: diameter 1 * 2.125; half ≈ 1.06, so the ink arm is 1.06 + 0.1 = 1.16 (beats 0.85·1).
        const el = linear({ type: 'freedraw', points: '[[0,0],[100,0]]', strokeWidth: 1, width: 100, height: 0 });
        expect(hitTestElement(el, { x: 50, y: 1 }, 1)).toBe(true);
        expect(hitTestElement(el, { x: 50, y: 1.3 }, 1)).toBe(false);
    });

    test('a closed, filled line is hit inside the polygon; transparent is outline-only', () => {
        const points = '[[0,0],[100,0],[50,80],[0,0]]';
        const filled = linear({ points, fill: solidFill('#ff0000'), width: 100, height: 80 });
        const open = linear({ points, fill: solidFill('transparent'), width: 100, height: 80 });
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

// Spread-only so the ellipse case doesn't trip the excess-property check on `corners`.
const SHAPE_BASE: Omit<VectorRectangleElement, 'id' | 'type'> = {
    ...DEFAULT_ELEMENT_PROPS,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    index: 'a0',
    fill: solidFill('transparent'),
    roughness: 1,
    seed: 1,
    corners: 'straight',
};

const shapeEl = (over: Partial<VectorShapeElement> & Pick<VectorShapeElement, 'id' | 'type'>): VectorShapeElement => ({
    ...SHAPE_BASE,
    ...over,
});

const arrowEl = (over: Partial<VectorArrowElement> & { points: string }): VectorArrowElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    id: 'ar',
    type: 'arrow',
    roughness: 1,
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
    elbow: false,
    fixedSegments: '',
    text: '',
    fontSize: 20,
    fontFamily: 'Excalifont',
    labelWidth: 0,
    ...over,
});

const bind = (shape: VectorBindableElement, fixedPoint: [number, number]): string =>
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

describe('normalizeFixedPoint (Excalidraw bind-time bounds)', () => {
    test('clamps each ratio to ±10, leaving a mild out-of-[0,1] dock ratio intact', () => {
        // A dock a gap outside a 200-wide box reads back as ~-0.03 — kept, not unit-clamped.
        expect(normalizeFixedPoint([-0.03, 0.42])).toEqual([-0.03, 0.42]);
        expect(normalizeFixedPoint([1.03, 0.42])).toEqual([1.03, 0.42]);
        // Only a truly wild ratio (shrunk shape) is bounded, at ±10 not ±1.
        expect(normalizeFixedPoint([50, -50])).toEqual([10, -10]);
    });

    test('never returns exactly 0.5 on either axis (heading-cone stability)', () => {
        expect(normalizeFixedPoint([0.5, 0.5])).toEqual([0.5001, 0.5001]);
        // Only the near-0.5 axis is bumped; the other is left alone.
        expect(normalizeFixedPoint([0.5, 0.25])).toEqual([0.5001, 0.25]);
        expect(normalizeFixedPoint([0.8, 0.5])).toEqual([0.8, 0.5001]);
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

describe('docking on the true outline', () => {
    // 100×100, so `round` collapses the core to a point and the outline IS the inscribed circle (r 50).
    const rounded = (corners: Corners) =>
        shapeEl({ id: 's', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, corners });

    test('a diagonal ray lands on the corner arc, inside the sharp corner', () => {
        const sharp = outlinePoint(rounded('straight'), { x: 300, y: 300 }, { x: 50, y: 50 }, 0);
        const round = outlinePoint(rounded('round'), { x: 300, y: 300 }, { x: 50, y: 50 }, 0);
        expect(sharp.x).toBeCloseTo(100, 6);
        expect(round.x).toBeLessThan(sharp.x);
        expect(Math.hypot(round.x - 50, round.y - 50)).toBeCloseTo(50, 6);
    });

    test('an axis-aligned ray is unchanged by rounding', () => {
        const sharp = outlinePoint(rounded('straight'), { x: 50, y: -100 }, { x: 50, y: 50 }, 0);
        const round = outlinePoint(rounded('round'), { x: 50, y: -100 }, { x: 50, y: 50 }, 0);
        expect(sharp).toEqual({ x: 50, y: 0 });
        expect(round).toEqual(sharp);
    });

    test('the binding gap still applies on a rounded shape', () => {
        const hit = outlinePoint(rounded('round'), { x: 50, y: -100 }, { x: 50, y: 50 }, 8);
        expect(hit.y).toBeCloseTo(-8, 6);
    });

    test('a rotated rounded shape docks in its own frame', () => {
        const el = { ...rounded('round'), angle: 45 };
        const hit = outlinePoint(el, { x: 50, y: -200 }, { x: 50, y: 50 }, 0);
        expect(Math.hypot(hit.x - 50, hit.y - 50)).toBeCloseTo(50, 6);
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

    // Excalidraw's updateBoundPoint aims the chord from the ADJACENT vertex (index 1 / -2), not the far
    // endpoint — for a multi-point arrow the attachment must face the neighbouring vertex, so dragging a
    // mid point around the shape slides the endpoint along the outline. Identical for 2-point arrows.
    test('a multi-point end aims the chord from the adjacent vertex, not the far end', () => {
        // scene: start (-30,0), mid (-10,40), end near the rect; anchor = rect centre (25,0).
        // From the mid vertex the chord crosses the inflated outline on the TOP edge (2.25, 26);
        // from the far end it would cross the left edge at (-1, 0).
        const arrow = arrowEl({
            points: '[[0,0],[20,40],[36,0]]',
            x: -30,
            y: 0,
            width: 66,
            height: 40,
            endBinding: bind(shape, [0.5, 0.5]),
        });
        const p = boundEndpoint(arrow, 'end', shape);
        expect(p.x).toBeCloseTo(2.25);
        expect(p.y).toBeCloseTo(26);
    });

    // An elbow end derives from the fixedPoint alone — no chord, the other end never enters — so the
    // stored fixedPoint's own side is authoritative. A straight end keeps the chord orbit above (unchanged).
    test('elbow end resolves the fixedPoint dock on its own side, ignoring the other end', () => {
        // 200×100 rect; a fixedPoint a gap OUTSIDE the left edge (-0.03) is the far-side dock.
        const rect = shapeEl({ id: 'rect', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, strokeWidth: 2 });
        const elbow = arrowEl({
            points: '[[0,0],[400,0]]',
            x: -6,
            y: 50,
            width: 406,
            elbow: true,
            fixedSegments: '',
            endBinding: bind(rect, [-0.03, 0.42]),
        });
        // end stored at scene (394,50) — far to the RIGHT of the rect — yet the dock is the LEFT side.
        const p = boundEndpoint(elbow, 'end', rect);
        expect(p).toEqual(elbowAnchorScene(rect, [-0.03, 0.42]));
        expect(p.x).toBeCloseTo(-6); // 200 * -0.03
        expect(p.y).toBeCloseTo(42); // 100 * 0.42
        // The other end sits at x=-6 (far left in scene); moving conceptually never enters the computation:
        // boundEndpoint took no `from`/chord path, so the same call is invariant to the stored other point.
    });
});

describe('arrowCurveBeziers', () => {
    // The geometry-side curve is golden-locked to roughjs's `gen.curve` control points at roughness 0 —
    // the exact spline the renderer draws (Catmull-Rom, curveTightness 0, endpoints duplicated).
    const pts: Point[] = [
        { x: 0, y: 0 },
        { x: 30, y: 40 },
        { x: 80, y: 10 },
        { x: 120, y: 60 },
    ];

    test('matches roughjs gen.curve control points byte-for-byte at roughness 0', () => {
        const gen = new RoughGenerator({});
        const drawable = gen.curve(
            pts.map((p): [number, number] => [p.x, p.y]),
            { roughness: 0, curveTightness: 0, disableMultiStroke: true, seed: 1 },
        );
        const ops = drawable.sets[0].ops;
        const bcurves = ops.filter((o) => o.op === 'bcurveTo');
        const beziers = arrowCurveBeziers(pts);
        expect(ops[0].op).toBe('move');
        expect(ops[0].data).toEqual([beziers[0][0].x, beziers[0][0].y]);
        expect(bcurves.length).toBe(beziers.length);
        for (let i = 0; i < beziers.length; i++) {
            const [, c1, c2, c3] = beziers[i];
            expect(bcurves[i].data).toEqual([c1.x, c1.y, c2.x, c2.y, c3.x, c3.y]);
        }
    });

    test('a 2-point curve reduces to the straight chord', () => {
        const beziers = arrowCurveBeziers([
            { x: 0, y: 0 },
            { x: 60, y: 20 },
        ]);
        expect(beziers.length).toBe(1);
        const [, c1, c2] = beziers[0];
        // control points collinear with the chord ⇒ a straight line
        expect(c1).toEqual({ x: 10, y: 10 / 3 });
        expect(c2).toEqual({ x: 50, y: 50 / 3 });
    });
});

describe('boundEndpoint — curve-exact docking', () => {
    // A rectangle to the right of the arrow (as in the chord tests); left inflated side at x = 5 - 6 = -1.
    const rect = shapeEl({ id: 'rect', type: 'rectangle', x: 5, y: -20, width: 40, height: 40, strokeWidth: 2 });
    const ell = shapeEl({ id: 'ell', type: 'ellipse', x: 5, y: -20, width: 40, height: 40, strokeWidth: 2 });
    const dia = shapeEl({ id: 'dia', type: 'diamond', x: 5, y: -20, width: 40, height: 40, strokeWidth: 2 });

    // A strongly curved 3-point arrow that swings up from below-left toward the shape centre; the curved
    // shaft meets the outline at a different place than the straight chord from the adjacent vertex.
    const curvedArrow = (over: Partial<VectorArrowElement> = {}) =>
        arrowEl({
            points: '[[0,0],[10,60],[70,20]]',
            x: -40,
            y: -30,
            width: 70,
            height: 60,
            roundness: 'round',
            endBinding: bind(rect, [0.5, 0.5]),
            ...over,
        });

    const onInflatedRect = (p: Point, s: VectorShapeElement, gap = 6) => {
        const left = s.x - gap;
        const right = s.x + s.width + gap;
        const top = s.y - gap;
        const bottom = s.y + s.height + gap;
        return Math.min(Math.abs(p.x - left), Math.abs(p.x - right), Math.abs(p.y - top), Math.abs(p.y - bottom));
    };

    test('a curved 3-point arrow docks off the chord for rectangle / ellipse / diamond', () => {
        for (const shape of [rect, ell, dia]) {
            const curved = curvedArrow({ endBinding: bind(shape, [0.5, 0.5]) });
            const sharp = curvedArrow({ endBinding: bind(shape, [0.5, 0.5]), roundness: 'sharp' });
            const curveP = boundEndpoint(curved, 'end', shape);
            const chordP = boundEndpoint(sharp, 'end', shape);
            // curve solve genuinely moves the endpoint along the outline
            expect(Math.hypot(curveP.x - chordP.x, curveP.y - chordP.y)).toBeGreaterThan(0.1);
            expect(Number.isFinite(curveP.x)).toBe(true);
            expect(Number.isFinite(curveP.y)).toBe(true);
        }
    });

    test('the curved dock lands on the inflated rectangle outline', () => {
        const curveP = boundEndpoint(curvedArrow(), 'end', rect);
        expect(onInflatedRect(curveP, rect)).toBeLessThan(0.05);
    });

    test('the curved dock is endpoint-independent: feeding the solved endpoint back re-solves to it', () => {
        const arrow = curvedArrow();
        const first = boundEndpoint(arrow, 'end', rect);
        // Same interior vertices, only the stored endpoint replaced by the solved dock.
        const refed = arrowEl({
            ...arrow,
            points: serializePoints([{ x: 0, y: 0 }, { x: 10, y: 60 }, linearSceneToLocal(arrow, first)]),
        });
        const second = boundEndpoint(refed, 'end', rect);
        expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeLessThan(0.02);
    });

    test('rotated target: curve docking is transparent to a square shape rotated 90°', () => {
        const flat = shapeEl({ id: 's', type: 'rectangle', x: 5, y: -20, width: 40, height: 40, strokeWidth: 2 });
        const turned = { ...flat, angle: 90 };
        const a = boundEndpoint(curvedArrow({ endBinding: bind(flat, [0.5, 0.5]) }), 'end', flat);
        const b = boundEndpoint(curvedArrow({ endBinding: bind(turned, [0.5, 0.5]) }), 'end', turned);
        expect(b.x).toBeCloseTo(a.x, 4);
        expect(b.y).toBeCloseTo(a.y, 4);
    });

    test('a 2-point round arrow docks exactly on the chord (no curve path)', () => {
        const twoPt = arrowEl({
            points: '[[0,0],[36,0]]',
            x: -30,
            y: 0,
            width: 36,
            roundness: 'round',
            endBinding: bind(rect, [0.5, 0.5]),
        });
        const sharp = arrowEl({ ...twoPt, roundness: 'sharp' });
        expect(boundEndpoint(twoPt, 'end', rect)).toEqual(boundEndpoint(sharp, 'end', rect));
    });

    test('a sharp 3-point arrow is untouched by the curve path', () => {
        const sharp = curvedArrow({ roundness: 'sharp' });
        const otherScene = linearLocalToScene(sharp, { x: 10, y: 60 });
        const anchor = anchorToScene(rect, [0.5, 0.5]);
        expect(boundEndpoint(sharp, 'end', rect)).toEqual(outlinePoint(rect, otherScene, anchor, bindingGap(rect)));
    });

    test('short curved arrow keeps the anchor guard (no NaN)', () => {
        const short = arrowEl({
            points: '[[0,0],[4,2],[9,0]]',
            x: -3,
            y: 0,
            width: 9,
            height: 2,
            roundness: 'round',
            endBinding: bind(rect, [0.5, 0.5]),
        });
        expect(boundEndpoint(short, 'end', rect)).toEqual(anchorToScene(rect, [0.5, 0.5]));
    });

    test('a curve that never reaches the outline falls back to the chord result, no NaN', () => {
        // A far-away shape the short arrow can never reach: the curve solve finds no crossing.
        const far = shapeEl({ id: 'far', type: 'rectangle', x: 5000, y: 5000, width: 40, height: 40, strokeWidth: 2 });
        const arrow = curvedArrow({ endBinding: bind(far, [0.5, 0.5]) });
        const p = boundEndpoint(arrow, 'end', far);
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
    });
});

describe('binding a rich text box', () => {
    // Rich text is a DOM box, but an arrow docks on it exactly as on a rectangle: the outline the kind
    // declares (rounded by `corners`), the gap its stroke width sets, the follow every bound end gets.
    // Same box as followBindings' rectangle, so the two are directly comparable.
    const box = richtext({ id: 'txt', x: 150, y: -30, width: 60, height: 60, corners: 'curved' });
    const byId = new Map<string, VectorElement>([[box.id, box]]);
    const toward = arrowEl({ points: '[[0,0],[100,0]]', width: 100, endBinding: bind(box, [0, 0.5]) });

    test('an arrow docks on the box outline, gap and all', () => {
        // the left inflated side sits at 150 - gap(6) = 144
        expect(followBindings(toward, byId)).toEqual({
            x: 0,
            y: 0,
            width: 144,
            height: 0,
            points: '[[0,0],[144,0]]',
            fixedSegments: '',
        });
    });

    test('the dock is the same one a rectangle of that box would give', () => {
        const rect = shapeEl({
            id: box.id,
            type: 'rectangle',
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            corners: box.corners,
            strokeWidth: box.strokeWidth,
        });
        expect(followBindings(toward, byId)).toEqual(followBindings(toward, new Map([[rect.id, rect]])));
    });

    test('the bound arrow follows the box when it moves', () => {
        const moved = new Map<string, VectorElement>([[box.id, { ...box, x: 250 }]]);
        expect(followBindings(toward, moved)).toMatchObject({ width: 244, points: '[[0,0],[244,0]]' });
    });

    test('the dock honours the rounded corner the box is drawn with', () => {
        const sharp: VectorRichTextElement = { ...box, corners: 'straight' };
        // aimed diagonally at the top-left corner anchor, where a rounded outline and a sharp one differ
        const atCorner = arrowEl({
            points: '[[0,0],[50,50]]',
            x: 100,
            y: -80,
            width: 50,
            height: 50,
            endBinding: bind(box, [0, 0]),
        });
        const curvedDock = boundEndpoint(atCorner, 'end', box);
        const sharpDock = boundEndpoint(atCorner, 'end', sharp);
        expect(Math.hypot(curvedDock.x - sharpDock.x, curvedDock.y - sharpDock.y)).toBeGreaterThan(0.1);
    });
});

describe('followBindings', () => {
    const shapeB = shapeEl({ id: 'rect', type: 'rectangle', x: 150, y: -30, width: 60, height: 60, strokeWidth: 2 });
    const byId = new Map<string, VectorElement>([[shapeB.id, shapeB]]);

    // D5.5 (review MAJOR): a curved bound arrow must settle to a STRICT byte-equal fixed point, so an
    // unrelated edit re-running followBindings never re-dirties it (spurious undo entries + broadcast churn).
    const applyFollow = (arrow: VectorArrowElement, ids: Map<string, VectorElement>): VectorArrowElement => {
        const r = followBindings(arrow, ids);
        return r ? { ...arrow, ...r } : arrow;
    };

    for (const angle of [0, 37]) {
        for (const type of ['rectangle', 'ellipse', 'diamond'] as const) {
            test(`curved bound arrow reaches a byte-equal fixed point (${type}, angle ${angle})`, () => {
                const target = shapeEl({ id: 't', type, x: 120, y: -30, width: 60, height: 60, strokeWidth: 2, angle });
                const ids = new Map<string, VectorElement>([[target.id, target]]);
                const arrow = arrowEl({
                    points: '[[0,0],[30,50],[110,10]]',
                    x: 0,
                    y: 0,
                    width: 110,
                    height: 50,
                    roundness: 'round',
                    endBinding: bind(target, [0.5, 0.5]),
                });
                // The curve solve makes the points a strict byte-equal fixed point from the first settle.
                const a1 = applyFollow(arrow, ids);
                const a2 = applyFollow(a1, ids);
                expect(a2.points).toBe(a1.points);
                // followBindings converges to an exact no-op (returns null) within a bounded number of
                // passes and never oscillates. (The one extra pass beyond the points settling is
                // normalizeLinear rounding its full-precision width to match the rounded points — the same
                // behaviour the straight-chord path already has; not specific to curve docking.)
                let settled = a2;
                let steps = 0;
                let r = followBindings(settled, ids);
                while (r !== null && steps < 4) {
                    settled = { ...settled, ...r };
                    steps++;
                    r = followBindings(settled, ids);
                }
                expect(r).toBeNull();
                expect(settled.points).toBe(a1.points);
            });
        }
    }

    test('returns null when the arrow binds nothing', () => {
        expect(followBindings(arrowEl({ points: '[[0,0],[100,0]]' }), byId)).toBeNull();
    });

    test('recomputes a bound endpoint onto the current shape outline and re-normalizes', () => {
        const arrow = arrowEl({ points: '[[0,0],[100,0]]', width: 100, endBinding: bind(shapeB, [0, 0.5]) });
        const next = followBindings(arrow, byId);
        // shapeB's left inflated side is at 150 - gap(6) = 144; the start (unbound) stays at 0.
        expect(next).toEqual({ x: 0, y: 0, width: 144, height: 0, points: '[[0,0],[144,0]]', fixedSegments: '' });
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

    test('an elbow with a STALE >2-point stored box uses the route bounds when the route is passed', () => {
        // A pinned/converted elbow whose stored box is stale-wide (200x160) but whose real polyline spans
        // only 80x60. The selection/union/ring path passes the route, so the box must track the route — a
        // stale stored frame (Reinder\'s below-right ghost box) must never leak.
        const stale = arrowEl({
            points: '[[0,0],[40,0],[40,60],[80,60]]',
            elbow: true,
            x: 0,
            y: 0,
            width: 200,
            height: 160,
        });
        const route = parsePoints(stale.points);
        // With the route: bounds are the polyline bbox (80x60), NOT the stale 200x160 stored box.
        const b = elementBounds(stale, route);
        expect([b.minX, b.minY, b.maxX, b.maxY]).toEqual([0, 0, 80, 60]);
        // Without a route (a callsite that forgot it) it would fall back to the stale box — the trap.
        const stale2 = elementBounds(stale);
        expect(stale2.maxX).toBe(200);
        expect(b.maxX).not.toBe(stale2.maxX);
    });

    // render and hitTest both guard an empty route; bounds must too, or ±Infinity reaches the shared
    // viewBox and the whole document exports blank.
    test('an empty route falls back to the stored box instead of ±Infinity', () => {
        const el = arrowEl({ points: '[[0,0],[100,0]]', width: 100, height: 0 });
        expect(elementBounds(el, [])).toEqual(getElementBounds(el));
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

// An elbow arrow's visible shape is its DERIVED route (elbowRoute), not the straight 2-point line; the
// route is passed into hit-testing and bounds so both track the snake. followBindings still moves the two
// stored endpoints, and a shape move re-routes through it.
describe('elbow arrows — derived-route consumption', () => {
    // Unbound diagonal elbow: elbowRoute yields the Z [(0,0),(50,0),(50,80),(100,80)].
    const elbow = arrowEl({ points: '[[0,0],[100,80]]', elbow: true, width: 100, height: 80 });
    const route = elbowRoute(elbow, new Map([[elbow.id, elbow]]));

    test('hitTestElement grabs a routed segment only when the route is supplied', () => {
        // (30,0) sits on the route's first horizontal arm but ~19 units off the straight endpoint line.
        expect(hitTestElement(elbow, { x: 30, y: 0 }, 2, route)).toBe(true);
        expect(hitTestElement(elbow, { x: 30, y: 0 }, 2)).toBe(false);
        // Clear of every routed arm.
        expect(hitTestElement(elbow, { x: 30, y: 60 }, 2, route)).toBe(false);
    });

    test('elementBounds is the routed polyline bbox', () => {
        expect(elementBounds(elbow, route)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 80 });
    });

    test('a bound shape move re-routes through followBindings', () => {
        const a = shapeEl({ id: 'A', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, strokeWidth: 2 });
        const b = shapeEl({ id: 'B', type: 'rectangle', x: 200, y: 0, width: 100, height: 100, strokeWidth: 2 });
        const arrow = arrowEl({
            points: '[[0,0],[100,0]]',
            x: 100,
            y: 50,
            width: 100,
            height: 0,
            elbow: true,
            fixedSegments: '',
            startBinding: bind(a, [1, 0.5]),
            endBinding: bind(b, [0, 0.5]),
        });
        const before = elbowRoute(
            arrow,
            new Map<string, VectorElement>([
                [a.id, a],
                ['B', b],
                [arrow.id, arrow],
            ]),
        );

        // Move B down; followBindings snaps the end endpoint onto B's new outline, and the route follows.
        const b2 = { ...b, y: 160 };
        const followed = followBindings(
            arrow,
            new Map<string, VectorElement>([
                [a.id, a],
                ['B', b2],
            ]),
        );
        expect(followed).not.toBeNull();
        if (!followed) return;
        const moved: VectorArrowElement = { ...arrow, ...followed };
        const after = elbowRoute(
            moved,
            new Map<string, VectorElement>([
                [a.id, a],
                ['B', b2],
                [moved.id, moved],
            ]),
        );
        expect(after).not.toEqual(before);
    });
});

// --- projectFixedPointOntoDiagonal (bind-time aim) ---------------------------------
// Excalidraw's projectFixedPointOntoDiagonal: a straight arrow's bind-time aim snaps to a side midpoint the
// cursor is near, else projects onto the shape's diagonals (rect) / centre lines (ellipse/diamond) along the
// ray from the other end, accepted only inside the shape; null → fall back to the raw cursor.
describe('projectFixedPointOntoDiagonal', () => {
    // A point P is collinear with the infinite line through A,B (the shrunk diagonal is a sub-segment of it).
    const onLine = (a: Point, b: Point, p: Point): boolean =>
        Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < 1e-6;
    const big = { width: 200, height: 100 };

    test('a degenerate arrow (both extents < 3) never projects', () => {
        const rect = shapeEl({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 });
        expect(
            projectFixedPointOntoDiagonal(rect, { x: 120, y: 60 }, { x: 100, y: 300 }, { width: 2, height: 2 }, 1),
        ).toBeNull();
    });

    test('snaps to the nearest side midpoint when the cursor sits just outside one', () => {
        const rect = shapeEl({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, strokeWidth: 2 });
        // 5px right of the right-edge midpoint (200,50); within bindingDistance(1)+strokeWidth/2 = 16, outside the shape.
        const p = projectFixedPointOntoDiagonal(rect, { x: 205, y: 50 }, { x: -300, y: 50 }, big, 1);
        expect(p).toEqual({ x: 200, y: 50 });
    });

    test('a cursor buried inside the shape does NOT midpoint-snap — it projects onto a diagonal', () => {
        const rect = shapeEl({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 });
        // (120,60) is inside; the ray from far below projects onto a corner diagonal, not a side midpoint.
        const p = projectFixedPointOntoDiagonal(rect, { x: 120, y: 60 }, { x: 100, y: 300 }, big, 1);
        expect(p).not.toBeNull();
        if (!p) return;
        expect(hitTestBox(rect, p)).toBe(true);
        const tlbr = onLine({ x: 0, y: 0 }, { x: 200, y: 100 }, p);
        const trbl = onLine({ x: 200, y: 0 }, { x: 0, y: 100 }, p);
        expect(tlbr || trbl).toBe(true);
    });

    test('an ellipse projects onto its centre lines (vertical x=centre or horizontal y=centre)', () => {
        const ell = shapeEl({ id: 'e', type: 'ellipse', x: 0, y: 0, width: 200, height: 100 });
        const p = projectFixedPointOntoDiagonal(ell, { x: 120, y: 40 }, { x: 100, y: 300 }, big, 1);
        expect(p).not.toBeNull();
        if (!p) return;
        expect(hitTestEllipse(ell, p)).toBe(true);
        const vertical = onLine({ x: 100, y: 0 }, { x: 100, y: 100 }, p);
        const horizontal = onLine({ x: 0, y: 50 }, { x: 200, y: 50 }, p);
        expect(vertical || horizontal).toBe(true);
    });

    test('returns null when the ray crosses the diagonals only outside the shape', () => {
        const rect = shapeEl({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 });
        // A vertical ray at x=500 never meets the shrunk diagonals (x in [13,187]); nothing to project onto.
        expect(projectFixedPointOntoDiagonal(rect, { x: 500, y: 400 }, { x: 500, y: 500 }, big, 1)).toBeNull();
    });

    test('rotational equivariance: rotating the shape + inputs rotates the projection', () => {
        const rect0 = shapeEl({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 });
        const rect30 = { ...rect0, angle: 30 };
        const center = boxCenter(rect0);
        const point0 = { x: 120, y: 60 };
        const other0 = { x: 100, y: 300 };
        const p0 = projectFixedPointOntoDiagonal(rect0, point0, other0, big, 1);
        const p30 = projectFixedPointOntoDiagonal(
            rect30,
            rotatePoint(point0, center, 30),
            rotatePoint(other0, center, 30),
            big,
            1,
        );
        expect(p0).not.toBeNull();
        expect(p30).not.toBeNull();
        if (!p0 || !p30) return;
        const expected = rotatePoint(p0, center, 30);
        expect(p30.x).toBeCloseTo(expected.x, 6);
        expect(p30.y).toBeCloseTo(expected.y, 6);
    });

    test('the bound ratio stored is the projection, not the raw cursor', () => {
        const rect = shapeEl({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 });
        const raw = { x: 120, y: 60 };
        const projected = projectFixedPointOntoDiagonal(rect, raw, { x: 100, y: 300 }, big, 1);
        expect(projected).not.toBeNull();
        if (!projected) return;
        // The stored fixedPoint is the projection's ratio; anchorToScene round-trips back to the projection,
        // and it differs from anchoring the raw cursor (proof the projection actually moved the aim).
        const stored = bindingAnchor(rect, projected);
        const back = anchorToScene(rect, stored);
        expect(back.x).toBeCloseTo(projected.x, 6);
        expect(back.y).toBeCloseTo(projected.y, 6);
        expect(stored).not.toEqual(bindingAnchor(rect, raw));
    });
});

describe('shapeAnchorPoints', () => {
    test('rect/ellipse → right, bottom, left, top edge midpoints (Excalidraw order)', () => {
        const rect = shapeEl({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 });
        expect(shapeAnchorPoints(rect)).toEqual([
            { x: 200, y: 50 },
            { x: 100, y: 100 },
            { x: 0, y: 50 },
            { x: 100, y: 0 },
        ]);
    });

    test('diamond → its four vertices/tips (right, bottom, left, top)', () => {
        const dia = shapeEl({ id: 'd', type: 'diamond', x: 0, y: 0, width: 200, height: 100 });
        expect(shapeAnchorPoints(dia)).toEqual([
            { x: 200, y: 50 },
            { x: 100, y: 100 },
            { x: 0, y: 50 },
            { x: 100, y: 0 },
        ]);
    });
});

describe('focusSnapPoint (eigen extension)', () => {
    const rect = () => shapeEl({ id: 'r', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 });
    // zoom 1 ⇒ bindingDistance 15 + strokeWidth/2 (1) = 16px magnet radius.
    test('snaps the aim to the nearest side midpoint within the band', () => {
        expect(focusSnapPoint(rect(), { x: 198, y: 50 }, 1)).toEqual({ x: 200, y: 50 });
        expect(focusSnapPoint(rect(), { x: 100, y: 3 }, 1)).toEqual({ x: 100, y: 0 });
    });
    test('snaps to the centre when the aim sits near the middle', () => {
        expect(focusSnapPoint(rect(), { x: 102, y: 52 }, 1)).toEqual({ x: 100, y: 50 });
    });
    test('returns null past the band (no magnet — the raw aim stands)', () => {
        expect(focusSnapPoint(rect(), { x: 100, y: 200 }, 1)).toBeNull();
        expect(focusSnapPoint(rect(), { x: 50, y: 50 }, 1)).toBeNull();
    });
});

describe('hitThresholdScreen', () => {
    test('a fine pointer grabs at the base screen threshold', () => {
        expect(hitThresholdScreen(false)).toBe(HIT_THRESHOLD_SCREEN);
    });

    test('a coarse pointer fattens the threshold by the slop multiplier', () => {
        expect(hitThresholdScreen(true)).toBe(HIT_THRESHOLD_SCREEN * COARSE_HIT_SLOP_MULTIPLIER);
        expect(hitThresholdScreen(true)).toBeGreaterThan(hitThresholdScreen(false));
    });
});
