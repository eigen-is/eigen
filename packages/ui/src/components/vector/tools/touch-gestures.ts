// Touch / stylus gesture policy for the vector canvas, ported from Excalidraw (App.tsx:8398-8432 spike
// discard, 8446-8453 penMode latch, 8578-8588 palm-rejection allowlist, 9061 pinch-pin-mid-freedraw).
// The canvas only DISPATCHES into these handlers; all touch LOGIC lives here so the canvas file stays
// flat (CANVAS.md's rule that vector-canvas.tsx must not grow). Three behaviors:
//   - penMode latch: the first stylus pointerdown flips a session-scoped penMode; while it's on a finger
//     can no longer draw/create (palm rejection) but still selects and pans. A mouse is never affected.
//   - two-finger pan + pinch-zoom: a second touch aborts the one-finger gesture (a freehand spike is
//     discarded, a real stroke finalizes) and both fingers then drive pan/pinch through the viewport,
//     which stays the single zoom owner.
//   - double-tap: two quick stationary taps enter text editing via the SAME entry a mouse double-click
//     uses; a touch that DRAGS never taps, so a drag can never enter text editing.

import { type MutableRefObject, useRef } from 'react';
import type { VectorTool } from '../hooks/use-tool';

export type TouchXY = { x: number; y: number };

// Below this live-point count a second-finger interruption treats the freehand stroke as a palm spike
// and discards it; at or above it the stroke finalizes (Excalidraw App.tsx:8406).
export const SPIKE_MAX_POINTS = 10;
export function isFreedrawSpike(pointCount: number): boolean {
    return pointCount < SPIKE_MAX_POINTS;
}

// While a stylus stroke is live every touch is ignored entirely — palm rejection wins over the
// two-finger takeover, so the pinch stays pinned out (Excalidraw App.tsx:9061 pinch-pin-mid-freedraw).
// A TOUCH-originated stroke has no such lock: its second touch runs the spike-discard→pinch handoff.
export function touchIgnoredDuringPen(penDrawing: boolean): boolean {
    return penDrawing;
}

// A finger keeps operating these tools even after a pen has latched penMode (Excalidraw's allowlist,
// App.tsx:8580-8585 — selection/lasso/text/image; ours is select + text). Every other tool draws or
// creates, so a finger is locked out of it while a pen is in use.
const PEN_MODE_TOUCH_ALLOWED: ReadonlySet<VectorTool> = new Set<VectorTool>(['select', 'text']);
export function touchAllowedInPenMode(tool: VectorTool): boolean {
    return PEN_MODE_TOUCH_ALLOWED.has(tool);
}

// Incremental pan+pinch from one two-finger frame: `scale` is the finger-spread ratio, the pan is the
// midpoint's screen travel, both applied about the current midpoint. Pure so the math is unit-tested.
export type PinchFrame = { scale: number; midX: number; midY: number; panDx: number; panDy: number };
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

// Two stationary taps within this time/space window synthesize a double-tap → text edit.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 24; // screen px, coarse-pointer sized
const TAP_MAX_MS = 250; // a longer press isn't a tap
const TAP_MAX_MOVE = 10; // a moved pointer is a drag, never a tap (a drag can't enter text editing)

export type Tap = { t: number; x: number; y: number };
export function isDoubleTap(prev: Tap | null, curr: Tap): boolean {
    return (
        prev !== null &&
        curr.t - prev.t <= DOUBLE_TAP_MS &&
        Math.hypot(curr.x - prev.x, curr.y - prev.y) <= DOUBLE_TAP_DIST
    );
}

type DownInfo = { t: number; x: number; y: number; moved: boolean };
type TouchState = {
    // Active touch pointers by id, in client coords (updated every move so a late second finger has the
    // first finger's current position).
    pointers: Map<number, TouchXY>;
    // The two pointer ids driving a live pinch/pan, or null.
    twoFinger: { a: number; b: number } | null;
    // Session latch — once a stylus is seen a finger can't draw (survives for the canvas' lifetime).
    penMode: boolean;
    downInfo: Map<number, DownInfo>;
    lastTap: Tap | null;
};

export type TouchGesturesParams = {
    tool: VectorTool;
    containerRef: MutableRefObject<HTMLDivElement | null>;
    // The canvas' shared gesture-freeze flag (also the viewport's) — held true through a pinch so no
    // single-pointer gesture starts underneath it.
    frozenRef: MutableRefObject<boolean>;
    // Zoom about a container-relative anchor + pan by a screen delta. The viewport owns the clamp/anchor
    // math; this hook never duplicates it.
    pinch: (scale: number, px: number, py: number, panDxPx: number, panDyPx: number) => void;
    // Abort whatever one-finger gesture is live so two fingers can take over (freehand spike-discard or
    // finalize, and any canvas create/move/marquee).
    abortActiveGesture: () => void;
    // Whether a live draw gesture was started by a stylus — a pen stroke pins the pinch out (every
    // touch is ignored while it draws), a touch stroke keeps the spike-discard→handoff.
    isPenDrawing: () => boolean;
    // Enter text editing at a client point — the SAME entry a mouse double-click uses.
    onDoubleTap: (clientX: number, clientY: number) => void;
};

export type TouchGestures = {
    onPointerDown: (e: React.PointerEvent) => boolean;
    onPointerMove: (e: React.PointerEvent) => boolean;
    onPointerUp: (e: React.PointerEvent) => boolean;
    // Tear down all transient touch state (pointers, two-finger, tap tracking) — the canvas calls it
    // from its blur/pointercancel safety net so a torn-down gesture can't wedge later touches.
    reset: () => void;
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

    const onPointerDown = (e: React.PointerEvent): boolean => {
        // First stylus contact latches penMode for the session; the pen itself draws normally.
        if (e.pointerType === 'pen') {
            st.penMode = true;
            return false;
        }
        if (e.pointerType !== 'touch') return false;

        // A live stylus stroke pins the pinch out: every touch is ignored while it draws (palm
        // rejection wins over the two-finger takeover). A touch-originated stroke keeps the handoff.
        if (touchIgnoredDuringPen(params.isPenDrawing())) return true;

        st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        st.downInfo.set(e.pointerId, { t: performance.now(), x: e.clientX, y: e.clientY, moved: false });

        // Second finger → abort the one-finger gesture and hand both pointers to pan/pinch.
        if (st.pointers.size === 2) {
            const [a, b] = [...st.pointers.keys()];
            params.abortActiveGesture();
            st.twoFinger = { a, b };
            frozenRef.current = true;
            containerRef.current?.setPointerCapture(e.pointerId);
            return true;
        }
        // Third+ finger: ignore extras while a pinch runs.
        if (st.pointers.size > 2) return true;

        // First finger. Palm rejection: while a pen is in use a finger can't drive a draw/create tool.
        if (st.penMode && !touchAllowedInPenMode(tool)) return true;
        return false;
    };

    const onPointerMove = (e: React.PointerEvent): boolean => {
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

        // Single finger: keep its position current (so a late second finger pinches about the right
        // midpoint), but let the canvas/drawing hook drive the one-finger gesture.
        st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        return false;
    };

    const onPointerUp = (e: React.PointerEvent): boolean => {
        if (e.pointerType !== 'touch') return false;
        const wasTwoFinger = st.twoFinger !== null;
        st.pointers.delete(e.pointerId);
        const di = st.downInfo.get(e.pointerId);
        st.downInfo.delete(e.pointerId);

        if (wasTwoFinger) {
            // A finger lifted out of a pinch: end it. The remaining finger does NOT resume drawing
            // (Excalidraw parity) — it idles until lifted.
            st.twoFinger = null;
            frozenRef.current = false;
            return true;
        }

        // Single-finger tap → double-tap detection for text-edit entry. A moved (dragged) or long press
        // is never a tap, so a drag can never open the editor.
        if (di && !di.moved && performance.now() - di.t <= TAP_MAX_MS) {
            const tap = { t: performance.now(), x: e.clientX, y: e.clientY };
            if (isDoubleTap(st.lastTap, tap)) {
                st.lastTap = null;
                // Clean the second tap's own (movement-free, so no-op) gesture and reset the freeze
                // before opening the editor, then claim the event so the canvas skips its finishGesture.
                params.abortActiveGesture();
                params.onDoubleTap(e.clientX, e.clientY);
                return true;
            }
            st.lastTap = tap;
        }
        return false;
    };

    // Clear ALL transient state so a two-finger gesture torn down by window blur / pointercancel can
    // never leave stale pointers, a live twoFinger, or tap tracking that wedges later touches. The
    // penMode latch is session-scoped by design (a stylus was seen) and deliberately survives.
    const reset = () => {
        st.pointers.clear();
        st.twoFinger = null;
        st.downInfo.clear();
        st.lastTap = null;
    };

    return { onPointerDown, onPointerMove, onPointerUp, reset };
}
