import { describe, expect, test } from 'bun:test';
import { materializeFirstPin, moveEndpoints, moveSegment, renormalize, unpinSegment } from '../../vector/elbow-pins';
import { parsePoints } from '../../vector/geometry';
import { DEFAULT_ELEMENT_PROPS, parseFixedSegments, type VectorArrowElement } from '../../vector/types';

const arrowEl = (over: Partial<VectorArrowElement> & { points: string }): VectorArrowElement => ({
    ...DEFAULT_ELEMENT_PROPS,
    id: 'ar',
    type: 'arrow',
    x: 0,
    y: 0,
    width: 0,
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
    fixedSegments: '',
    text: '',
    fontSize: 20,
    fontFamily: 'Excalifont',
    labelWidth: 0,
    ...over,
});

// A clean 4-point L with the vertical middle segment (index 2) pinned in place.
const pinnedL = (): VectorArrowElement =>
    arrowEl({
        points: '[[0,0],[40,0],[40,60],[80,60]]',
        width: 80,
        height: 60,
        fixedSegments:
            '{"segments":[{"index":2,"start":[40,0],"end":[40,60]}],"startIsSpecial":false,"endIsSpecial":false}',
    });

// The polyline in scene coordinates (angle 0 ⇒ +x/+y).
const scenePoints = (patch: { points: string; x: number; y: number }): [number, number][] =>
    parsePoints(patch.points).map((p) => [patch.x + p.x, patch.y + p.y]);

describe('elbow-pins — P13 acceptance (interior segment drag)', () => {
    test('dragging the pinned middle segment right shifts the SAME L, zero extra corners, seamless joints', () => {
        const arrow = pinnedL();
        // Drag the index-2 (vertical) segment dot right by 20: cursor x = 60 in scene.
        const patch = moveSegment(arrow, 2, { x: 60, y: 30 });
        const pts = scenePoints(patch);
        // Still four points — no new corners.
        expect(pts.length).toBe(4);
        // The same L, its vertical segment now at x=60, neighbours stretched.
        expect(pts).toEqual([
            [0, 0],
            [60, 0],
            [60, 60],
            [80, 60],
        ]);
        // Release renormalization is a no-op for this clean drag ⇒ preview===commit to the point.
        const committed = renormalize({ ...arrow, ...patch });
        expect(committed.points).toBe(patch.points);
        expect(scenePoints(committed)).toEqual(pts);
        // The pin is still index 2, its coords rebuilt from the moved polyline.
        expect(parseFixedSegments(committed.fixedSegments).segments).toEqual([
            { index: 2, start: [60, 0], end: [60, 60] },
        ]);
    });

    test('the moved segment stays axis-locked (a vertical pin keeps its y-endpoints)', () => {
        const patch = moveSegment(pinnedL(), 2, { x: 25, y: 999 });
        expect(scenePoints(patch)).toEqual([
            [0, 0],
            [25, 0],
            [25, 60],
            [80, 60],
        ]);
    });
});

describe('elbow-pins — materialize + unpin', () => {
    test('the first pin freezes the derived route into points and pins the dragged segment (P4)', () => {
        // A straight 2-point elbow whose derived route is an L (the caller passes it in).
        const arrow = arrowEl({ points: '[[0,0],[80,60]]', width: 80, height: 60 });
        const route = parsePoints('[[0,0],[40,0],[40,60],[80,60]]');
        const patch = materializeFirstPin(arrow, route, 2, { x: 60, y: 30 });
        expect(patch.fixedSegments).not.toBe('');
        expect(scenePoints(patch)).toEqual([
            [0, 0],
            [60, 0],
            [60, 60],
            [80, 60],
        ]);
    });

    test('unpinning the only pin returns to derived mode (2 points, fixedSegments empty) (P8)', () => {
        const patch = unpinSegment(pinnedL(), 2);
        expect(patch.fixedSegments).toBe('');
        expect(parsePoints(patch.points).length).toBe(2);
    });
});

describe('elbow-pins — P6 endpoint move keeps the interior verbatim', () => {
    test('moving the end re-drops only the end connector; the pinned middle holds', () => {
        const arrow = pinnedL();
        // Move the end from (80,60) to (120,60).
        const patch = moveEndpoints(arrow, null, { x: 120, y: 60 });
        const committed = renormalize({ ...arrow, ...patch });
        const pts = scenePoints(committed);
        // Interior (the pinned x=40 vertical) unchanged; only the last point moved.
        expect(pts[0]).toEqual([0, 0]);
        expect(pts.some((p) => p[0] === 40)).toBe(true);
        expect(pts[pts.length - 1]).toEqual([120, 60]);
        expect(parseFixedSegments(committed.fixedSegments).segments[0]).toEqual({
            index: 2,
            start: [40, 0],
            end: [40, 60],
        });
    });
});
