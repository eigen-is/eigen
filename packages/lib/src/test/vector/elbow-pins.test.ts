import { describe, expect, test } from 'bun:test';
import {
    materializeFirstPin,
    moveEndpoints,
    moveSegment,
    type PinRoutingContext,
    renormalize,
    unpinSegment,
} from '../../vector/elbow-pins';
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

describe('elbow-pins — interior segment drag', () => {
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
    test('the first pin freezes the derived route into points and pins the dragged segment', () => {
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

    test('unpinning the only pin returns to derived mode (2 points, fixedSegments empty)', () => {
        const patch = unpinSegment(pinnedL(), 2);
        expect(patch.fixedSegments).toBe('');
        expect(parsePoints(patch.points).length).toBe(2);
    });
});

describe('elbow-pins — endpoint move keeps the interior verbatim', () => {
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

// --- Unit 6: first/last-segment jog (port of Excalidraw's handleSegmentMove end-segment branches) ---

// A pin routing context (headings + per-end bound flags) as elbow-pins consumes it — decomposed at the
// call seam (getHeadingForElbowArrowSnap → horizontal/positive) so elbow-pins stays pure.
const ctx = (over: Partial<PinRoutingContext> = {}): PinRoutingContext => ({
    startBound: false,
    endBound: false,
    startHeadingHorizontal: false,
    startHeadingPositive: false,
    endHeadingHorizontal: false,
    endHeadingPositive: false,
    ...over,
});

describe('elbow-pins — first/last-segment jog', () => {
    // A straight 2-point elbow whose derived route is an L (the caller passes the route in).
    const straightL = () => arrowEl({ points: '[[0,0],[80,60]]', width: 80, height: 60 });

    test('first-segment drag, UNBOUND: inserts ONE jog point (+1), holds both endpoints, pin goes interior', () => {
        const route = parsePoints('[[0,0],[40,0],[40,60],[80,60]]');
        const patch = materializeFirstPin(straightL(), route, 1, { x: 20, y: 20 }, ctx());
        const pts = scenePoints(patch);
        expect(pts.length).toBe(5); // route had 4, jog +1
        expect(pts[0]).toEqual([0, 0]); // start endpoint held
        expect(pts[pts.length - 1]).toEqual([80, 60]); // end endpoint held
        const segs = parseFixedSegments(patch.fixedSegments).segments;
        expect(segs.length).toBe(1);
        expect(segs[0].index).toBeGreaterThanOrEqual(2); // now interior
        expect(segs[0].index).toBeLessThanOrEqual(pts.length - 2);
    });

    test('first-segment drag, BOUND start: inserts TWO points (+2), preserves endpoint verbatim, pads outer vertex', () => {
        const arrow = arrowEl({ points: '[[0,0],[100,80]]', width: 100, height: 80 });
        const route = parsePoints('[[0,0],[60,0],[60,80],[100,80]]');
        const c = ctx({ startBound: true, startHeadingHorizontal: true, startHeadingPositive: true });
        const patch = materializeFirstPin(arrow, route, 1, { x: 20, y: 20 }, c);
        const pts = scenePoints(patch);
        expect(pts.length).toBe(6); // jog +2
        expect(pts[0]).toEqual([0, 0]); // endpoint preserved verbatim
        const segs = parseFixedSegments(patch.fixedSegments).segments;
        expect(segs[0].index).toBe(3); // reindexed +2 from 1
        expect(segs[0].start).toEqual([40, 20]); // outer vertex padded BASE_PADDING(40) along RIGHT heading
    });

    test('last-segment drag, UNBOUND: symmetric tail jog (+1), no reindex, holds the end endpoint', () => {
        const route = parsePoints('[[0,0],[40,0],[40,60],[80,60]]');
        const c = ctx({ endHeadingHorizontal: true, endHeadingPositive: false });
        const patch = materializeFirstPin(straightL(), route, 3, { x: 60, y: 40 }, c);
        const pts = scenePoints(patch);
        expect(pts.length).toBe(5);
        expect(pts[pts.length - 1]).toEqual([80, 60]); // end endpoint held
        const segs = parseFixedSegments(patch.fixedSegments).segments;
        expect(segs[0].index).toBe(3); // tail insert ⇒ no reindex
    });

    test('last-segment drag, BOUND end: inserts TWO points (+2), preserves end endpoint verbatim, pads outer vertex', () => {
        const arrow = arrowEl({ points: '[[0,0],[120,80]]', width: 120, height: 80 });
        const route = parsePoints('[[0,0],[40,0],[40,80],[120,80]]');
        const c = ctx({ endBound: true, endHeadingHorizontal: true, endHeadingPositive: true });
        const patch = materializeFirstPin(arrow, route, 3, { x: 60, y: 40 }, c);
        const pts = scenePoints(patch);
        expect(pts.length).toBe(6);
        expect(pts[pts.length - 1]).toEqual([120, 80]); // end endpoint preserved verbatim
        const segs = parseFixedSegments(patch.fixedSegments).segments;
        expect(segs[0].index).toBe(3); // tail insert ⇒ no reindex
        expect(segs[0].end).toEqual([160, 40]); // outer vertex padded BASE_PADDING(40) along RIGHT heading
    });

    test('renormalize keeps the once-first pin interior after the jog', () => {
        const arrow = arrowEl({ points: '[[0,0],[100,80]]', width: 100, height: 80 });
        const route = parsePoints('[[0,0],[60,0],[60,80],[100,80]]');
        const c = ctx({ startBound: true, startHeadingHorizontal: true, startHeadingPositive: true });
        const patch = materializeFirstPin(arrow, route, 1, { x: 20, y: 20 }, c);
        const committed = renormalize({ ...arrow, ...patch });
        const segs = parseFixedSegments(committed.fixedSegments).segments;
        expect(segs.length).toBe(1); // survives — no longer flush with an endpoint
        expect(segs[0].index).toBe(3);
    });
});

describe('elbow-pins — bound-shape move sets isSpecial without corner accretion', () => {
    // A 5-point pinned arrow whose start leaves its bound shape parallel to the second segment.
    const base = () =>
        arrowEl({
            points: '[[0,0],[0,50],[90,50],[90,120],[150,120]]',
            width: 150,
            height: 120,
            fixedSegments:
                '{"segments":[{"index":2,"start":[0,50],"end":[90,50]}],"startIsSpecial":false,"endIsSpecial":false}',
        });

    test('a heading-parallel bound-shape move inserts the L-jog and sets startIsSpecial', () => {
        const c = ctx({ startBound: true, startHeadingHorizontal: true, startHeadingPositive: true });
        const patch = moveEndpoints(base(), { x: 0, y: 0 }, null, c);
        expect(parsePoints(patch.points).length).toBe(6); // +1 synthetic point
        expect(parseFixedSegments(patch.fixedSegments).startIsSpecial).toBe(true);
    });

    test('repeated bound-shape moves do not accrete corners (idempotent point count)', () => {
        const c = ctx({ startBound: true, startHeadingHorizontal: true, startHeadingPositive: true });
        const first = moveEndpoints(base(), { x: 0, y: 0 }, null, c);
        const second = moveEndpoints({ ...base(), ...first }, { x: 0, y: 0 }, null, c);
        expect(parsePoints(second.points).length).toBe(6); // still 6, not accreting
        expect(second.points).toBe(first.points); // pixel-identical replay
    });
});

describe('elbow-pins — release/delete on an end pin', () => {
    test('unpinning the sole once-first pin returns to derived mode (fixedSegments empty, 2 points)', () => {
        const arrow = arrowEl({ points: '[[0,0],[100,80]]', width: 100, height: 80 });
        const route = parsePoints('[[0,0],[60,0],[60,80],[100,80]]');
        const c = ctx({ startBound: true, startHeadingHorizontal: true, startHeadingPositive: true });
        const patch = materializeFirstPin(arrow, route, 1, { x: 20, y: 20 }, c);
        const pinned = { ...arrow, ...patch };
        const segs = parseFixedSegments(pinned.fixedSegments).segments;
        const released = unpinSegment(pinned, segs[0].index);
        expect(released.fixedSegments).toBe('');
        expect(parsePoints(released.points).length).toBe(2);
    });
});
