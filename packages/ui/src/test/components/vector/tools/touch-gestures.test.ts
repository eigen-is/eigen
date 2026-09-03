import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    isDoubleTap,
    isFreedrawSpike,
    pinchFrame,
    SPIKE_MAX_POINTS,
    swipeFrameDelta,
    type Tap,
    type TouchGestures,
    type TouchGesturesParams,
    type TouchPointerEvent,
    type TouchXY,
    touchAllowedInPenMode,
    touchIgnoredDuringPen,
    useTouchGestures,
} from '../../../../components/vector/tools/touch-gestures';

// The pure decisions below need no harness, but the swipe's abort-then-page ORDER is a property of the
// hook. One static render captures the handlers; they close over the hook's state ref and keep working.
function renderTouchGestures(overrides: Partial<TouchGesturesParams>): TouchGestures {
    const held: { gestures: TouchGestures | null } = { gestures: null };
    const Probe = () => {
        held.gestures = useTouchGestures({
            tool: 'select',
            containerRef: { current: null },
            frozenRef: { current: false },
            pinch: () => undefined,
            abortActiveGesture: () => undefined,
            isPenDrawing: () => false,
            onDoubleTap: () => undefined,
            ...overrides,
        });
        return null;
    };
    renderToStaticMarkup(createElement(Probe));
    if (!held.gestures) throw new Error('the probe never rendered');
    return held.gestures;
}

function touchEvent(e: { pointerId: number; clientX: number; clientY: number }): TouchPointerEvent {
    return { pointerType: 'touch', ...e };
}

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
        expect(touchAllowedInPenMode('richtext')).toBe(true);
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

describe('swipeFrameDelta', () => {
    test('a long leftward drag steps to the next frame', () => {
        expect(swipeFrameDelta(-120, 10)).toBe(1);
    });

    test('a long rightward drag steps back', () => {
        expect(swipeFrameDelta(120, -10)).toBe(-1);
    });

    test('a short drag is not a swipe', () => {
        expect(swipeFrameDelta(-40, 0)).toBe(0);
    });

    test('a mostly vertical drag is not a swipe', () => {
        expect(swipeFrameDelta(-100, 80)).toBe(0);
    });
});

describe('a swipe unwinds the pan it rode in on', () => {
    // A view-only canvas pans on any primary drag, so the swipe's own finger already started one. If
    // the hook claims the pointerup without aborting it, the canvas never runs finishGesture and the
    // viewport freeze survives — every later touch is dead. Mirrors the double-tap branch's contract.
    test('abortActiveGesture runs before onSwipe', () => {
        const calls: string[] = [];
        const gestures = renderTouchGestures({
            onSwipe: () => calls.push('swipe'),
            abortActiveGesture: () => calls.push('abort'),
        });
        gestures.onPointerDown(touchEvent({ pointerId: 1, clientX: 300, clientY: 400 }));
        gestures.onPointerMove(touchEvent({ pointerId: 1, clientX: 150, clientY: 405 }));
        expect(gestures.onPointerUp(touchEvent({ pointerId: 1, clientX: 150, clientY: 405 }))).toBe(true);
        expect(calls).toEqual(['abort', 'swipe']);
    });

    test('without onSwipe the same drag is left to the canvas as a plain pan', () => {
        const gestures = renderTouchGestures({});
        gestures.onPointerDown(touchEvent({ pointerId: 1, clientX: 300, clientY: 400 }));
        gestures.onPointerMove(touchEvent({ pointerId: 1, clientX: 150, clientY: 405 }));
        expect(gestures.onPointerUp(touchEvent({ pointerId: 1, clientX: 150, clientY: 405 }))).toBe(false);
    });
});
