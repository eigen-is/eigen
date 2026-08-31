import { describe, expect, test } from 'bun:test';
import {
    anchorToScene,
    bindingAnchor,
    DEFAULT_ARROW_PROPS,
    DEFAULT_ELEMENT_PROPS,
    parseBinding,
    projectFixedPointOntoDiagonal,
    serializeBinding,
    type VectorArrowElement,
    type VectorElement,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import { bindArrow, bindFocusPoint } from '../../../../components/vector/tools/binding';

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

describe('bindArrow — straight-arrow diagonal projection', () => {
    // A free start at scene (100,300) below the shape, the end dropped inside at scene (120,60): local points
    // relative to (x=100,y=60) are start (0,240), end (20,0).
    const shape = rect({ id: 'shape' });
    const el = arrow({ points: '[[0,240],[20,0]]', x: 100, y: 60, width: 20, height: 240 });
    const ordered: VectorElement[] = [shape, el];

    test('the end binding stores the projected ratio, not the raw drop', () => {
        const bound = bindArrow(el, { start: false, end: true }, ordered, 1, false);
        const stored = parseBinding(bound.endBinding);
        expect(stored).not.toBeNull();
        if (!stored) return;
        const raw = { x: 120, y: 60 };
        const projected = projectFixedPointOntoDiagonal(shape, raw, { x: 100, y: 300 }, el, 1);
        expect(projected).not.toBeNull();
        if (!projected) return;
        // Stored ratio matches the projection's ratio, and differs from the raw drop's ratio.
        expect(stored.fixedPoint[0]).toBeCloseTo(bindingAnchor(shape, projected)[0], 6);
        expect(stored.fixedPoint[1]).toBeCloseTo(bindingAnchor(shape, projected)[1], 6);
        expect(stored.fixedPoint).not.toEqual(bindingAnchor(shape, raw));
    });

    test('an elbow arrow is never diagonal-projected (raw anchor kept)', () => {
        const elbow = arrow({ points: '[[0,240],[20,0]]', x: 100, y: 60, width: 20, height: 240, elbow: true });
        const bound = bindArrow(elbow, { start: false, end: true }, [shape, elbow], 1, false);
        const stored = parseBinding(bound.endBinding);
        expect(stored).not.toBeNull();
        if (!stored) return;
        expect(stored.fixedPoint).toEqual(bindingAnchor(shape, { x: 120, y: 60 }));
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
