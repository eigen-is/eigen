// Segment-pin handles for a single selected ELBOW arrow (EP-U5, Excalidraw's fixedSegments UX). An elbow
// arrow derives its orthogonal route from its two endpoints, so — unlike a line — its bends have no stored
// vertices to grab (LinePointHandles shows only its endpoint dots). This overlay adds a translucent
// `.eigen-midpoint-handle` dot at the middle of each INTERIOR route segment (the first and last segment
// can't be fixed — they anchor the endpoints, Excalidraw's invariant). Dragging a dot PINS that segment:
// it locks to its own axis and glides perpendicular under the cursor, and the whole snake re-routes live
// around it; release seals ONE write of the updated `fixedSegments`. Double-clicking a dot on an
// already-pinned segment UNPINS it (one sealed write). Self-contained like LinePointHandles: it owns its
// drag lifecycle under an AbortController and reports the live route via `onPreview`, committing on release.

import {
    type Box,
    type FixedSegment,
    linearLocalToScene,
    linearSceneToLocal,
    type Point,
    parseFixedSegments,
    serializeFixedSegments,
    type VectorArrowElement,
} from '@workspace/lib/vector';
import type { MutableRefObject } from 'react';
import { useEffect, useRef } from 'react';

// A pin drag stays inert until the pointer travels this many CLIENT px, so a plain click adds nothing
// (Excalidraw's DRAG_THRESHOLD for the segment handle).
const PIN_DRAG_THRESHOLD_PX = 2;
// A segment shorter than this on SCREEN shows no dot (Excalidraw's POINT_HANDLE_SIZE·4), matching the
// line midpoint gate.
const PIN_MIN_SEGMENT_SCREEN_PX = 40;
// Two route vertices are "the same" (a pin matches a route segment) within this local distance.
const PIN_MATCH_EPS = 0.5;

type ElbowPinHandlesProps = {
    arrow: VectorArrowElement;
    // The DERIVED route in the arrow's local frame (arrowRoute) — the segments the dots sit on.
    route: Point[];
    zoom: number;
    boxToStyle: (box: Box) => React.CSSProperties;
    clientToScene: (clientX: number, clientY: number) => Point;
    frozenRef: MutableRefObject<boolean>;
    // Live `fixedSegments` during a drag (null clears the preview back to the committed arrow).
    onPreview: (fixedSegments: string | null) => void;
    // One sealed write of the updated `fixedSegments` (a new/moved pin on drag, a removed pin on unpin).
    onCommit: (fixedSegments: string) => void;
};

// Whether two local points coincide within the match epsilon.
function near(a: Point, b: Point): boolean {
    return Math.abs(a.x - b.x) < PIN_MATCH_EPS && Math.abs(a.y - b.y) < PIN_MATCH_EPS;
}

// The index of the stored pin that renders as this route segment [a,b] (its two vertices, either
// orientation), or -1 when the segment isn't pinned.
function pinIndexForSegment(pins: FixedSegment[], a: Point, b: Point): number {
    return pins.findIndex((p) => {
        const ps = { x: p.start[0], y: p.start[1] };
        const pe = { x: p.end[0], y: p.end[1] };
        return (near(ps, a) && near(pe, b)) || (near(ps, b) && near(pe, a));
    });
}

// The pin a dragged segment [a,b] becomes: axis-locked (its own orientation kept) and slid onto the
// cursor's local point `q` on the perpendicular axis. A horizontal segment keeps its x-endpoints and
// takes the cursor y; a vertical one keeps its y-endpoints and takes the cursor x.
function pinnedSegment(a: Point, b: Point, q: Point): FixedSegment {
    const horizontal = a.y === b.y;
    return horizontal ? { start: [a.x, q.y], end: [b.x, q.y] } : { start: [q.x, a.y], end: [q.x, b.y] };
}

export function ElbowPinHandles({
    arrow,
    route,
    zoom,
    boxToStyle,
    clientToScene,
    frozenRef,
    onPreview,
    onCommit,
}: ElbowPinHandlesProps) {
    const abortRef = useRef<AbortController | null>(null);
    // Tear the document listeners down if the element unmounts mid-drag (a remote delete).
    useEffect(() => () => abortRef.current?.abort(), []);

    const pins = parseFixedSegments(arrow.fixedSegments);

    // Begin pinning the segment [a,b] (route indices i, i+1). The pin replaces any existing pin on that
    // same segment, so re-dragging a pinned segment moves it rather than stacking a duplicate.
    const startDrag = (e: React.PointerEvent, a: Point, b: Point) => {
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
        // Every pin except one on THIS segment (that one is being replaced/moved).
        const others = pins.filter((_, idx) => idx !== pinIndexForSegment(pins, a, b));
        let active = false;
        let latest: string | null = null;

        const update = (clientX: number, clientY: number) => {
            const q = linearSceneToLocal(arrow, clientToScene(clientX, clientY));
            latest = serializeFixedSegments([...others, pinnedSegment(a, b, q)]);
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
            // A click that never travelled pins nothing.
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

    // Double-click on a pinned segment's dot removes that pin (one sealed write).
    const unpin = (a: Point, b: Point) => {
        const idx = pinIndexForSegment(pins, a, b);
        if (idx === -1) return;
        onCommit(serializeFixedSegments(pins.filter((_, i) => i !== idx)));
    };

    // Position a dot centred on a local point in the host's screen frame — its size/hit area come from the
    // .eigen-midpoint-handle CSS token, so the JSX only places it.
    const dotStyle = (local: Point): React.CSSProperties => {
        const scene = linearLocalToScene(arrow, local);
        const { left, top } = boxToStyle({ x: scene.x, y: scene.y, width: 0, height: 0, angle: 0 });
        return { left, top, transform: 'translate(-50%, -50%)' };
    };

    return (
        <>
            {route.slice(0, -1).map((a, i) => {
                // Interior segments only — the first (i === 0) and last anchor the endpoints and can't be
                // pinned (Excalidraw's invariant).
                if (i === 0 || i === route.length - 2) return null;
                const b = route[i + 1];
                if (Math.hypot(b.x - a.x, b.y - a.y) * zoom < PIN_MIN_SEGMENT_SCREEN_PX) return null;
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                const pinned = pinIndexForSegment(pins, a, b) !== -1;
                return (
                    <div
                        key={`p${i}`}
                        className={`eigen-midpoint-handle pointer-events-auto touch-none cursor-pointer${
                            pinned ? ' eigen-point-handle-doubled' : ''
                        }`}
                        style={dotStyle(mid)}
                        onPointerDown={(e) => startDrag(e, a, b)}
                        onDoubleClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            unpin(a, b);
                        }}
                    />
                );
            })}
        </>
    );
}
