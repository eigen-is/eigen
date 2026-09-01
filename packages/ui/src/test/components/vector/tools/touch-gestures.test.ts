import { describe, expect, test } from 'bun:test';
import {
    isDoubleTap,
    isFreedrawSpike,
    pinchFrame,
    SPIKE_MAX_POINTS,
    type Tap,
    type TouchXY,
    touchAllowedInPenMode,
    touchIgnoredDuringPen,
} from '../../../../components/vector/tools/touch-gestures';

describe('isFreedrawSpike', () => {
    test('a short live stroke (< 10 points) is a spike → discard', () => {
        expect(isFreedrawSpike(0)).toBe(true);
        expect(isFreedrawSpike(SPIKE_MAX_POINTS - 1)).toBe(true);
    });

    test('a stroke at or past the threshold finalizes', () => {
        expect(isFreedrawSpike(SPIKE_MAX_POINTS)).toBe(false);
        expect(isFreedrawSpike(50)).toBe(false);
    });
});

describe('touchAllowedInPenMode', () => {
    test('a finger still selects and types while a pen is in use', () => {
        expect(touchAllowedInPenMode('select')).toBe(true);
        expect(touchAllowedInPenMode('text')).toBe(true);
    });

    test('a finger is locked out of every draw/create tool in penMode', () => {
        for (const tool of ['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'eraser'] as const) {
            expect(touchAllowedInPenMode(tool)).toBe(false);
        }
    });
});

describe('touchIgnoredDuringPen', () => {
    test('a live pen stroke ignores a second touch entirely — no abort, no pinch handoff', () => {
        expect(touchIgnoredDuringPen(true)).toBe(true);
    });

    test('a touch-originated stroke has no such lock — the second touch runs the discard/handoff', () => {
        expect(touchIgnoredDuringPen(false)).toBe(false);
    });
});

describe('pinchFrame', () => {
    const a = (x: number, y: number): TouchXY => ({ x, y });

    test('spreading the fingers zooms in (scale > 1) about the shared midpoint', () => {
        // Two fingers on a horizontal line, 100px apart → 200px apart; midpoint unchanged at (100, 0).
        const f = pinchFrame(a(50, 0), a(150, 0), a(0, 0), a(200, 0));
        expect(f.scale).toBeCloseTo(2, 6);
        expect(f.midX).toBe(100);
        expect(f.midY).toBe(0);
        expect(f.panDx).toBe(0);
        expect(f.panDy).toBe(0);
    });

    test('pinching in zooms out (scale < 1)', () => {
        const f = pinchFrame(a(0, 0), a(200, 0), a(50, 0), a(150, 0));
        expect(f.scale).toBeCloseTo(0.5, 6);
    });

    test('a rigid two-finger slide pans by the midpoint delta at scale 1', () => {
        const f = pinchFrame(a(0, 0), a(100, 0), a(30, 40), a(130, 40));
        expect(f.scale).toBeCloseTo(1, 6);
        expect(f.panDx).toBe(30);
        expect(f.panDy).toBe(40);
    });

    test('a degenerate zero-distance previous frame holds scale at 1 (no divide-by-zero)', () => {
        const f = pinchFrame(a(10, 10), a(10, 10), a(0, 0), a(20, 0));
        expect(f.scale).toBe(1);
    });
});

describe('isDoubleTap', () => {
    const tap = (t: number, x: number, y: number): Tap => ({ t, x, y });

    test('no prior tap is never a double-tap', () => {
        expect(isDoubleTap(null, tap(100, 0, 0))).toBe(false);
    });

    test('two quick stationary taps are a double-tap', () => {
        expect(isDoubleTap(tap(0, 10, 10), tap(200, 12, 8))).toBe(true);
    });

    test('a slow second tap is not a double-tap', () => {
        expect(isDoubleTap(tap(0, 10, 10), tap(400, 10, 10))).toBe(false);
    });

    test('a far-away second tap is not a double-tap', () => {
        expect(isDoubleTap(tap(0, 10, 10), tap(100, 100, 100))).toBe(false);
    });
});
