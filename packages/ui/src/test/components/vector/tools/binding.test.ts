import { describe, expect, test } from 'bun:test';
import {
    anchorToScene,
    bindingAnchor,
    bindingGap,
    boundEndpoint,
    DEFAULT_ARROW_PROPS,
    DEFAULT_ELEMENT_PROPS,
    parseBinding,
    projectFixedPointOntoDiagonal,
    rotatePoint,
    serializeBinding,
    shapeSideMidpoints,
    type VectorArrowElement,
    type VectorElement,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import { bindArrow, bindFocusPoint } from '../../../../components/vector/tools/binding';

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// EP-U4/D5: a straight arrow's bind stores the DIAGONAL-PROJECTED aim (Excalidraw's
// projectFixedPointOntoDiagonal), while dragging its focus dot stores the RAW aim (handleFocusPointDrag).
// Points are stored RELATIVE to (x,y) with the bbox min corner at (0,0) (normalizeLinear's invariant).

const rect = (over: Partial<VectorShapeElement> & Pick<VectorShapeElement, 'id'>): VectorShapeElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    type: 'rectangle',
    // A filled shape binds anywhere inside (a transparent one binds only in the outline band), so a
    // dropped-inside endpoint reaches it.
    backgroundColor: '#dddddd',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    angle: 0,
    seed: 1,
    index: 'a0',
    roundness: 'sharp',
    ...over,
});

const arrow = (over: Partial<VectorArrowElement> & { points: string }): VectorArrowElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    ...DEFAULT_ARROW_PROPS,
    id: 'ar',
    type: 'arrow',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    seed: 1,
    index: 'a1',
    roundness: 'sharp',
    text: '',
    fontSize: 20,
    fontFamily: 'Excalifont',
    ...over,
});

// EP-U4 regression (symptom A): a straight arrow's bind projects the raw endpoint onto a diagonal / centre
// line ONLY when the endpoint lands OUTSIDE the shape's fill (Excalidraw's "orbit" strategy). A drop INSIDE
// the fill is the "inside" strategy and stores the RAW cursor ratio verbatim — re-projecting an inside drop
// flung the stored anchor off the release point onto the diagonal (the hollow dot lands deep toward the
// centre). This is what breaks when an already-bound endpoint is re-dragged to a new spot on the same shape.
describe('bindArrow — inside drop stores the raw release ratio (no diagonal overshoot)', () => {
    // The bound-endpoint drop is inside the 200×100 fill at scene (60,30) → ratio [0.3, 0.3]; the OTHER end
    // is free far away so it can't bind and only serves as the projection ray origin.
    for (const end of ['start', 'end'] as const) {
        for (const angle of [0, 30]) {
            test(`${end} end, ${angle}° rect: the stored anchor is the release point, not a diagonal projection`, () => {
                const shape = rect({ id: 'shape', angle });
                // Release point = the scene position of ratio [0.3,0.3] on this (possibly rotated) shape.
                const drop = anchorToScene(shape, [0.3, 0.3]);
                const free = { x: 100, y: 700 }; // far below — reaches nothing
                const startScene = end === 'start' ? drop : free;
                const endScene = end === 'start' ? free : drop;
                const el = arrow({
                    points: JSON.stringify([
                        [startScene.x, startScene.y],
                        [endScene.x, endScene.y],
                    ]),
                    x: 0,
                    y: 0,
                    width: Math.abs(startScene.x - endScene.x) || 1,
                    height: Math.abs(startScene.y - endScene.y) || 1,
                });
                const bound = bindArrow(el, { start: end === 'start', end: end === 'end' }, [shape, el], 1, false);
                const stored = parseBinding(end === 'start' ? bound.startBinding : bound.endBinding);
                expect(stored).not.toBeNull();
                if (!stored) return;
                // Stored ratio is the raw release point's ratio.
                expect(stored.fixedPoint[0]).toBeCloseTo(0.3, 6);
                expect(stored.fixedPoint[1]).toBeCloseTo(0.3, 6);
                // …and it does NOT match what the diagonal projection would have stored (the regression value).
                const projected = projectFixedPointOntoDiagonal(shape, drop, free, el, 1);
                expect(projected).not.toBeNull();
                if (!projected) return;
                const projRatio = bindingAnchor(shape, projected);
                expect(
                    dist({ x: stored.fixedPoint[0], y: stored.fixedPoint[1] }, { x: projRatio[0], y: projRatio[1] }),
                ).toBeGreaterThan(0.05);
            });
        }
    }

    test('an elbow arrow keeps the raw anchor too (never diagonal-projected)', () => {
        const shape = rect({ id: 'shape' });
        const elbow = arrow({ points: '[[0,240],[20,0]]', x: 100, y: 60, width: 20, height: 240, elbow: true });
        const bound = bindArrow(elbow, { start: false, end: true }, [shape, elbow], 1, false);
        const stored = parseBinding(bound.endBinding);
        expect(stored).not.toBeNull();
        if (!stored) return;
        expect(stored.fixedPoint).toEqual(bindingAnchor(shape, { x: 120, y: 60 }));
    });
});

// The complement: releasing ON a lit side-midpoint snap dot (OUTSIDE the fill) still snaps — the anchor
// lands exactly on the dot and the bound endpoint docks at the outline right there, not toward the centre.
describe('bindArrow — outside side-midpoint drop snaps the anchor onto the dot', () => {
    for (const end of ['start', 'end'] as const) {
        for (const angle of [0, 30]) {
            test(`${end} end, ${angle}° rect: anchor rests on the right-edge midpoint`, () => {
                const shape = rect({ id: 'shape', angle });
                const rightMid = shapeSideMidpoints(shape)[0]; // right, bottom, left, top order
                // 5px outside the right edge (local (205,50)) — outside the fill, within the snap band.
                const drop = rotatePoint({ x: 205, y: 50 }, { x: 100, y: 50 }, angle);
                // The free end sits far along the right edge's outward normal, so the chord crosses the right
                // edge AT the midpoint — the docked endpoint then rests on the dot too, not just the anchor.
                const free = rotatePoint({ x: 600, y: 50 }, { x: 100, y: 50 }, angle);
                const startScene = end === 'start' ? drop : free;
                const endScene = end === 'start' ? free : drop;
                const el = arrow({
                    points: JSON.stringify([
                        [startScene.x, startScene.y],
                        [endScene.x, endScene.y],
                    ]),
                    x: 0,
                    y: 0,
                    width: Math.abs(startScene.x - endScene.x) || 1,
                    height: Math.abs(startScene.y - endScene.y) || 1,
                });
                const bound = bindArrow(el, { start: end === 'start', end: end === 'end' }, [shape, el], 1, false);
                const committed = { ...el, ...bound };
                const stored = parseBinding(end === 'start' ? bound.startBinding : bound.endBinding);
                expect(stored).not.toBeNull();
                if (!stored) return;
                // The stored ratio is the right-edge midpoint ratio [1, 0.5]; the hollow aim dot sits on the dot.
                expect(stored.fixedPoint[0]).toBeCloseTo(1, 6);
                expect(stored.fixedPoint[1]).toBeCloseTo(0.5, 6);
                expect(dist(anchorToScene(shape, stored.fixedPoint), rightMid)).toBeCloseTo(0, 6);
                // The docked endpoint sits on the outline by the midpoint (within one binding gap), not deep inside.
                expect(dist(boundEndpoint(committed, end, shape), rightMid)).toBeLessThanOrEqual(
                    bindingGap(shape) + 1e-6,
                );
            });
        }
    }
});

// Symptom C trace (coordinator hypothesis of a start/end cross-link in the creation commit): DISPROVEN at
// this layer. bindArrow resolves each end independently, so an end-only bind leaves the start unbound and
// stationary, and two shapes yield two distinct bindings. These lock that in.
describe('bindArrow — multi-point ends bind independently (no cross-link)', () => {
    const shapeRight = rect({ id: 'right', x: 300, y: 0, width: 100, height: 100 });

    test('a 3-point arrow with only the END near a shape leaves the start unbound', () => {
        const el = arrow({ points: '[[0,0],[150,0],[350,50]]', x: 0, y: 0, width: 350, height: 50 });
        const bound = bindArrow(el, { start: true, end: true }, [shapeRight, el], 1, false);
        expect(bound.startBinding).toBe('');
        expect(parseBinding(bound.endBinding)?.elementId).toBe('right');
    });

    test('re-dragging the END of that arrow never moves the free start', () => {
        const el0 = arrow({ points: '[[0,0],[150,0],[350,50]]', x: 0, y: 0, width: 350, height: 50 });
        const created = { ...el0, ...bindArrow(el0, { start: true, end: true }, [shapeRight, el0], 1, false) };
        // Drag the end vertex to a new inside spot (scene 320,80); the start (scene 0,0) must hold.
        const reshaped = {
            ...created,
            points: JSON.stringify([
                [0, 0],
                [150, 0],
                [320, 80],
            ]),
            width: 320,
            height: 80,
        };
        const committed = {
            ...reshaped,
            ...bindArrow(reshaped, { start: false, end: true }, [shapeRight, reshaped], 1, false),
        };
        const firstPoint = JSON.parse(committed.points)[0];
        expect({ x: committed.x + firstPoint[0], y: committed.y + firstPoint[1] }).toEqual({ x: 0, y: 0 });
    });

    test('both ends near DIFFERENT shapes yield two distinct bindings', () => {
        const shapeLeft = rect({ id: 'left', x: -60, y: 20, width: 60, height: 60 });
        const el = arrow({ points: '[[-30,50],[150,0],[350,50]]', x: 0, y: 0, width: 380, height: 50 });
        const bound = bindArrow(el, { start: true, end: true }, [shapeLeft, shapeRight, el], 1, false);
        expect(parseBinding(bound.startBinding)?.elementId).toBe('left');
        expect(parseBinding(bound.endBinding)?.elementId).toBe('right');
    });
});

describe('bindFocusPoint — focus-dot drag stores the raw aim', () => {
    test('stores exactly the passed fixedPoint (no re-projection) and re-derives the endpoint', () => {
        const shape = rect({ id: 'shape' });
        // Start free at scene (300,50), end bound on the right edge (anchor ratio [1,0.5]); local points
        // relative to (x=200,y=50) are start (100,0), end (0,0).
        const el = arrow({
            points: '[[100,0],[0,0]]',
            x: 200,
            y: 50,
            width: 100,
            height: 0,
            endBinding: serializeBinding({ elementId: 'shape', fixedPoint: [1, 0.5] }),
        });
        const byId = new Map<string, VectorElement>([
            [shape.id, shape],
            [el.id, el],
        ]);
        const aim: [number, number] = [0.4, 0.7];
        const bound = bindFocusPoint(el, 'end', shape.id, aim, byId);
        const stored = parseBinding(bound.endBinding);
        expect(stored?.fixedPoint).toEqual(aim);
        // The endpoint is re-derived through the chord toward the other end (followBindings ran).
        expect(bound.points).not.toBe(el.points);
        // The anchor the arrow now aims at is the new ratio mapped onto the shape.
        expect(anchorToScene(shape, aim)).toEqual({ x: 80, y: 70 });
    });
});
