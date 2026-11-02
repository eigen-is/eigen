// The touch and stylus policy of the canvas editor, ported from Excalidraw: the palm-spike discard, the pen-mode latch,
// the palm-rejection allowlist and the pinch that pins a freehand stroke. The canvas only dispatches into these
// handlers, so every touch rule lives here and the canvas stays flat.

import type { MutableRefObject } from 'react';
import { useRef } from 'react';
import type { VectorTool } from '../hooks/use-tool';

export type TouchXY = { x: number; y: number };

// Everything the policy reads off a pointer event. The canvas hands it a real React.PointerEvent; naming
// the subset keeps the hook driveable without a DOM.
export type TouchPointerEvent = Pick<React.PointerEvent, 'pointerType' | 'pointerId' | 'clientX' | 'clientY'>;

export type TouchGesturesParams = {
    tool: VectorTool;
    containerRef: MutableRefObject<HTMLDivElement | null>;
    // The canvas's gesture freeze, which the viewport reads too. A pinch holds it, so no one-finger gesture starts
    // underneath.
    frozenRef: MutableRefObject<boolean>;
    // Zooms about a point relative to the container and pans by a screen delta. The viewport owns that math.
    pinch: (scale: number, px: number, py: number, panDxPx: number, panDyPx: number) => void;
    // Aborts the live one-finger gesture so two fingers can take over, such as a freehand stroke or a marquee.
    abortActiveGesture: () => void;
    // Whether a stylus started the live draw gesture. A pen stroke ignores every touch while it draws, so no pinch can
    // start. A stroke a finger started has no such lock: a second finger discards or finishes it and pinches.
    isPenDrawing: () => boolean;
    // Opens text editing at a client point, the same entry a mouse double-click uses.
    onDoubleTap: (clientX: number, clientY: number) => void;
    // Pages through the frames on a one-finger swipe. Only a host where a swipe means something passes it, such as a
    // frame-mode canvas the user cannot edit. Without it a swipe is just a pan.
    onSwipe?: (delta: number) => void;
};

export type TouchGestures = {
    onPointerDown: (e: TouchPointerEvent) => boolean;
    onPointerMove: (e: TouchPointerEvent) => boolean;
    onPointerUp: (e: TouchPointerEvent) => boolean;
    // Clears the touch state that lasts between events. The canvas calls it on blur and pointercancel, so a gesture
    // torn down half way can't wedge later touches.
    reset: () => void;
};

type DownInfo = { t: number; x: number; y: number; moved: boolean };
type TouchState = {
    // The live touch pointers by id, in client coordinates. Every move updates them, so a late second finger pinches
    // about the first finger's current position.
    pointers: Map<number, TouchXY>;
    // The two pointer ids driving a live pinch, or null.
    twoFinger: { a: number; b: number } | null;
    // Set once a stylus is seen, after which a finger can't draw. It lasts as long as the canvas.
    penMode: boolean;
    downInfo: Map<number, DownInfo>;
    lastTap: Tap | null;
};

export function useTouchGestures(params: TouchGesturesParams): TouchGestures {
    const stateRef = useRef<TouchState>({
        pointers: new Map(),
        twoFinger: null,
        penMode: false,
        downInfo: new Map(),
        lastTap: null,
    });
    const st = stateRef.current;
    const { tool, containerRef, frozenRef } = params;

    const onPointerDown = (e: TouchPointerEvent): boolean => {
        // The first stylus contact sets pen mode for the session; the pen itself draws normally.
        if (e.pointerType === 'pen') {
            st.penMode = true;
            return false;
        }
        if (e.pointerType !== 'touch') return false;

        // Palm rejection wins over the two-finger takeover: a live pen stroke ignores every touch.
        if (params.isPenDrawing()) return true;

        st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // A second finger aborts the one-finger gesture and hands both pointers to the pinch.
        if (st.pointers.size === 2) {
            const [a, b] = [...st.pointers.keys()];
            params.abortActiveGesture();
            // A gesture that ever held two fingers is a pinch and nothing else. Dropping the down info keeps the last
            // finger lifted from reading its pinch travel as a swipe or a tap.
            st.downInfo.clear();
            st.twoFinger = { a, b };
            frozenRef.current = true;
            containerRef.current?.setPointerCapture(e.pointerId);
            return true;
        }
        // A third finger and more are ignored while a pinch runs.
        if (st.pointers.size > 2) return true;

        st.downInfo.set(e.pointerId, { t: performance.now(), x: e.clientX, y: e.clientY, moved: false });

        // The first finger. While a pen is in use, a finger can't drive a tool that draws or creates.
        if (st.penMode && !touchAllowedInPenMode(tool)) return true;
        return false;
    };

    const onPointerMove = (e: TouchPointerEvent): boolean => {
        if (e.pointerType !== 'touch') return false;
        if (!st.pointers.has(e.pointerId)) return false;

        const di = st.downInfo.get(e.pointerId);
        if (di && !di.moved && Math.hypot(e.clientX - di.x, e.clientY - di.y) > TAP_MAX_MOVE) di.moved = true;

        if (st.twoFinger) {
            const { a, b } = st.twoFinger;
            if (e.pointerId !== a && e.pointerId !== b) return true;
            const prevA = st.pointers.get(a);
            const prevB = st.pointers.get(b);
            if (!prevA || !prevB) return true;
            const curr = { x: e.clientX, y: e.clientY };
            st.pointers.set(e.pointerId, curr);
            const currA = e.pointerId === a ? curr : prevA;
            const currB = e.pointerId === b ? curr : prevB;
            const f = pinchFrame(prevA, prevB, currA, currB);
            const rect = containerRef.current?.getBoundingClientRect();
            params.pinch(f.scale, f.midX - (rect?.left ?? 0), f.midY - (rect?.top ?? 0), f.panDx, f.panDy);
            return true;
        }

        // One finger: keep its position current, so a late second finger pinches about the right midpoint, but leave
        // the gesture itself to the canvas.
        st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        return false;
    };

    const onPointerUp = (e: TouchPointerEvent): boolean => {
        if (e.pointerType !== 'touch') return false;
        const wasTwoFinger = st.twoFinger !== null;
        st.pointers.delete(e.pointerId);
        const di = st.downInfo.get(e.pointerId);
        st.downInfo.delete(e.pointerId);

        if (wasTwoFinger) {
            // A finger lifted out of a pinch ends it. The other finger does not go back to drawing, as in Excalidraw:
            // it idles until it is lifted.
            st.twoFinger = null;
            frozenRef.current = false;
            return true;
        }

        // A one-finger swipe pages the deck. It is checked before the tap, because a swipe has moved and so could
        // never be a tap. The gesture must be aborted first. A view-only canvas starts a pan on the same pointerdown,
        // which sets the freeze and captures the pointer. Claiming the up here makes the canvas's own pointerup return
        // early, so a pan left running would keep the freeze and wedge every later touch. The double tap below aborts
        // for the same reason.
        if (di && params.onSwipe) {
            const delta = swipeFrameDelta(e.clientX - di.x, e.clientY - di.y);
            if (delta !== 0) {
                params.abortActiveGesture();
                params.onSwipe(delta);
                return true;
            }
        }

        // A one-finger tap may be the second of a double tap, which opens text editing. A drag or a long press is
        // never a tap, so a drag can never open the editor.
        if (di && !di.moved && performance.now() - di.t <= TAP_MAX_MS) {
            const tap = { t: performance.now(), x: e.clientX, y: e.clientY };
            if (isDoubleTap(st.lastTap, tap)) {
                st.lastTap = null;
                // The second tap started a gesture of its own, which moved nothing. Aborting it lifts the freeze
                // before the editor opens, and claiming the event makes the canvas skip its finishGesture.
                params.abortActiveGesture();
                params.onDoubleTap(e.clientX, e.clientY);
                return true;
            }
            st.lastTap = tap;
        }
        return false;
    };

    // The pen-mode latch survives on purpose: a stylus was seen, and that lasts for the session.
    const reset = () => {
        st.pointers.clear();
        st.twoFinger = null;
        st.downInfo.clear();
        st.lastTap = null;
    };

    return { onPointerDown, onPointerMove, onPointerUp, reset };
}

// Below this live-point count a second-finger interruption treats the freehand stroke as a palm spike
// and discards it; at or above it the stroke finalizes, as in Excalidraw.
export const SPIKE_MAX_POINTS = 10;
export function isFreedrawSpike(pointCount: number): boolean {
    return pointCount < SPIKE_MAX_POINTS;
}

// A finger keeps operating these tools even after a pen has latched penMode. Excalidraw's allowlist is
// selection, lasso, text and image; ours is select and text. Every other tool draws or
// creates, so a finger is locked out of it while a pen is in use.
const PEN_MODE_TOUCH_ALLOWED: ReadonlySet<VectorTool> = new Set<VectorTool>(['select', 'text']);
export function touchAllowedInPenMode(tool: VectorTool): boolean {
    return PEN_MODE_TOUCH_ALLOWED.has(tool);
}

// One two-finger frame of pan and pinch. `scale` is the ratio of the finger spread, and the pan is how far the
// midpoint moved on screen; both apply about the current midpoint. It is pure, so the math is unit-tested.
type PinchFrame = { scale: number; midX: number; midY: number; panDx: number; panDy: number };
export function pinchFrame(prevA: TouchXY, prevB: TouchXY, currA: TouchXY, currB: TouchXY): PinchFrame {
    const prevMidX = (prevA.x + prevB.x) / 2;
    const prevMidY = (prevA.y + prevB.y) / 2;
    const midX = (currA.x + currB.x) / 2;
    const midY = (currA.y + currB.y) / 2;
    const prevDist = Math.hypot(prevA.x - prevB.x, prevA.y - prevB.y);
    const currDist = Math.hypot(currA.x - currB.x, currA.y - currB.y);
    return {
        scale: prevDist > 0 ? currDist / prevDist : 1,
        midX,
        midY,
        panDx: midX - prevMidX,
        panDy: midY - prevMidY,
    };
}

// Two taps that stay put, close in time and space, make a double tap, which opens text editing.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 24; // screen px, coarse-pointer sized
const TAP_MAX_MS = 250; // a longer press isn't a tap
const TAP_MAX_MOVE = 10; // a pointer that moved further is a drag, never a tap

export type Tap = { t: number; x: number; y: number };
export function isDoubleTap(prev: Tap | null, curr: Tap): boolean {
    return (
        prev !== null &&
        curr.t - prev.t <= DOUBLE_TAP_MS &&
        Math.hypot(curr.x - prev.x, curr.y - prev.y) <= DOUBLE_TAP_DIST
    );
}

// A one-finger horizontal drag pages through the frames on a view-only phone. The minimum distance keeps a slow
// scroll from paging, and the 2:1 ratio keeps a diagonal drag out, because a finger that mostly moves up or down is
// not asking for the next slide. The result is a step in frames for useActiveFrame.step. A drag to the left moves the
// content left under the finger, as in every carousel, so it is +1: the next slide.
const SWIPE_MIN_DISTANCE = 60;
export function swipeFrameDelta(dx: number, dy: number): number {
    if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dx) <= Math.abs(dy) * 2) return 0;
    return dx < 0 ? 1 : -1;
}
