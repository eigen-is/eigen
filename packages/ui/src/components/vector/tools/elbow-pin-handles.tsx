// Segment-pin handles for a selected ELBOW arrow (EP-U5b, Excalidraw's fixedSegments UX). The dots sit on
// the interior segments of the arrow's route — the DERIVED route while unpinned, the stored polyline once
// pinned. Dragging a dot pins that segment: past a 2px threshold the first drag materializes the polyline
// (materializeFirstPin), later drags slide the segment in place (moveSegment) — axis-locked, zero new
// interior corners, the whole snake following live. Double-click (or Delete while the dot is selected)
// unpins. Pin identity is the polyline INDEX (segment i ⇒ index i+1) — never a geometric match — so a dot
// always knows whether its segment is pinned. Self-contained: owns its drag lifecycle under an
// AbortController; reports the live geometry patch via onPreview and commits it on release.

import {
    type Box,
    type FixedSegment,
    materializeFirstPin,
    moveSegment,
    type PinPatch,
    type Point,
    parseFixedSegments,
    unpinSegment,
    type VectorArrowElement,
} from '@workspace/lib/vector';
import type { MutableRefObject } from 'react';
import { useEffect, useRef } from 'react';

// A pin drag stays inert until the pointer travels this many CLIENT px (P9.1 — a click never pins).
const PIN_DRAG_THRESHOLD_PX = 2;
// A segment shorter than this on SCREEN shows no dot (matches the line midpoint gate).
const PIN_MIN_SEGMENT_SCREEN_PX = 40;

type ElbowPinHandlesProps = {
    arrow: VectorArrowElement;
    // The arrow's route in its local frame (arrowRoute): the derived route while unpinned, else the stored
    // polyline. Dot on segment i sits between route[i] and route[i+1] and keys polyline index i+1.
    route: Point[];
    zoom: number;
    boxToStyle: (box: Box) => React.CSSProperties;
    clientToScene: (clientX: number, clientY: number) => Point;
    frozenRef: MutableRefObject<boolean>;
    // Live geometry patch during a drag (null clears the preview back to the committed arrow).
    onPreview: (patch: PinPatch | null) => void;
    // One sealed write of the geometry patch (a new/moved pin on drag, a removed pin on unpin).
    onCommit: (patch: PinPatch) => void;
    // The pin (polyline index) the user has clicked to select — Delete on it unpins (P9.3).
    selectedPinIndex: number | null;
    onSelectPin: (index: number | null) => void;
};

export function ElbowPinHandles({
    arrow,
    route,
    zoom,
    boxToStyle,
    clientToScene,
    frozenRef,
    onPreview,
    onCommit,
    selectedPinIndex,
    onSelectPin,
}: ElbowPinHandlesProps) {
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => () => abortRef.current?.abort(), []);

    const pins: FixedSegment[] = parseFixedSegments(arrow.fixedSegments).segments;
    const isPinned = (index: number): boolean => pins.some((p) => p.index === index);

    // Begin pinning/moving the segment at polyline `index`. The first drag on an unpinned arrow freezes the
    // current route into points (materializeFirstPin); later drags slide the stored segment (moveSegment).
    const startDrag = (e: React.PointerEvent, index: number) => {
        e.preventDefault();
        e.stopPropagation();
        if (abortRef.current && !abortRef.current.signal.aborted) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        frozenRef.current = true;
        const controller = new AbortController();
        abortRef.current = controller;
        const { signal } = controller;
        const pointerId = e.pointerId;
        const startX = e.clientX;
        const startY = e.clientY;
        let active = false;
        let latest: PinPatch | null = null;

        const update = (clientX: number, clientY: number) => {
            const cursor = clientToScene(clientX, clientY);
            latest =
                arrow.fixedSegments === ''
                    ? materializeFirstPin(arrow, route, index, cursor)
                    : moveSegment(arrow, index, cursor);
            onPreview(latest);
        };
        const teardown = () => {
            frozenRef.current = false;
            controller.abort();
        };
        const onMove = (me: PointerEvent) => {
            if (me.pointerId !== pointerId) return;
            if (!active) {
                if (Math.hypot(me.clientX - startX, me.clientY - startY) < PIN_DRAG_THRESHOLD_PX) return;
                active = true;
            }
            update(me.clientX, me.clientY);
        };
        const onUp = (pe: PointerEvent) => {
            if (pe.pointerId !== pointerId) return;
            teardown();
            if (latest !== null) onCommit(latest);
            else onPreview(null);
        };
        const onKey = (ke: KeyboardEvent) => {
            if (ke.key !== 'Escape') return;
            ke.preventDefault();
            ke.stopPropagation();
            teardown();
            onPreview(null);
        };
        document.addEventListener('pointermove', onMove, { signal });
        document.addEventListener('pointerup', onUp, { signal });
        document.addEventListener('pointercancel', onUp, { signal });
        document.addEventListener('keydown', onKey, { signal, capture: true });
    };

    // Remove the pin at `index` (double-click or Delete on a selected pinned dot, P8/P9.3).
    const unpin = (index: number) => {
        if (!isPinned(index)) return;
        onSelectPin(null);
        onCommit(unpinSegment(arrow, index));
    };

    const dotStyle = (local: Point): React.CSSProperties => {
        const scene = { x: arrow.x + local.x, y: arrow.y + local.y };
        const { left, top } = boxToStyle({ x: scene.x, y: scene.y, width: 0, height: 0, angle: 0 });
        return { left, top, transform: 'translate(-50%, -50%)' };
    };

    return (
        <>
            {route.slice(0, -1).map((a, i) => {
                // Interior segments only — the first (i === 0) and last can't be fixed (Excalidraw's invariant).
                if (i === 0 || i === route.length - 2) return null;
                const b = route[i + 1];
                if (Math.hypot(b.x - a.x, b.y - a.y) * zoom < PIN_MIN_SEGMENT_SCREEN_PX) return null;
                const index = i + 1;
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                const pinned = isPinned(index);
                return (
                    <div
                        key={`p${index}`}
                        className={`eigen-midpoint-handle pointer-events-auto touch-none cursor-pointer${
                            pinned ? ' eigen-point-handle-doubled' : ''
                        }${selectedPinIndex === index ? ' eigen-vertex-handle-selected' : ''}`}
                        style={dotStyle(mid)}
                        onPointerDown={(e) => {
                            onSelectPin(pinned ? index : null);
                            startDrag(e, index);
                        }}
                        onDoubleClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            unpin(index);
                        }}
                    />
                );
            })}
        </>
    );
}
