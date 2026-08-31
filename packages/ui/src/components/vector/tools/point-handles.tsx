// Draggable vertex handles for a single selected line/arrow (R2.13, UA3, EP-PT) — round
// `.eigen-vertex-handle` dots, one per point, visually distinct from the square resize grips (a 2-point
// line/arrow shows these ONLY, with no ObjectTransform box). Clicking a vertex SELECTS that point (the
// host fills the selected dot via `selectedIndex` and lets Delete remove it); a plain drag still reshapes
// the line through normalizeLinear as one sealed undo step, and leaves the dragged point selected on
// release. Between every pair of adjacent vertices sits a translucent `.eigen-midpoint-handle` dot
// (Excalidraw's midpoint handle, the 2-point case included): dragging it INSERTS a vertex at that segment
// and continues as a normal vertex drag — the insert and the drag land in the single sealed write on
// release, and the inserted vertex ends up selected; a plain click on it (no travel past a few screen px)
// adds nothing, and Escape cancels the insert entirely. Elbow arrows derive their route from the two
// endpoints, so they show no midpoint dots (UA4 owns the elbow UI). Self-contained like ObjectTransform:
// it owns its drag lifecycle (document listeners under an AbortController) and reports the live points
// via `onPreview`, committing once on release. Freedraw shows no handles.

import {
    type Box,
    linearLocalToScene,
    linearSceneToLocal,
    type Point,
    parsePoints,
    type VectorArrowElement,
    type VectorLinearElement,
} from '@workspace/lib/vector';
import type { MutableRefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

// A midpoint drag only inserts once the pointer travels past this many CLIENT px — below it the gesture
// is a plain click that adds nothing (Excalidraw's DRAG_THRESHOLD for the midpoint handle).
const MIDPOINT_DRAG_THRESHOLD_PX = 2;
// A midpoint dot is hidden when its segment is shorter than this on SCREEN, so short segments don't
// clutter (Excalidraw's POINT_HANDLE_SIZE·4). The dot size itself lives in one place — the .eigen-*-handle
// CSS token (D9(e)); the JSX only positions it.
const MIDPOINT_MIN_SEGMENT_SCREEN_PX = 40;
// Two adjacent vertices this close on SCREEN render as ONE (doubled) dot instead of z-fighting; a click
// then prefers the higher index (the top-most DOM node, which we keep). Excalidraw's coincident-point merge.
const OVERLAP_MERGE_SCREEN_PX = 2;

type LinePointHandlesProps = {
    // A line or an arrow — both carry `points`; an arrow's endpoint drag additionally (re)binds (R3.10),
    // which the host resolves from the dragged vertex index.
    line: VectorLinearElement | VectorArrowElement;
    // Screen scale — gates the midpoint-length and overlap-merge thresholds to constant on-screen distances.
    zoom: number;
    boxToStyle: (box: Box) => React.CSSProperties;
    clientToScene: (clientX: number, clientY: number) => Point;
    frozenRef: MutableRefObject<boolean>;
    // Live points during a drag (null clears the preview) and the vertex index being dragged; the host
    // renders the reshaped element and highlights a binding candidate under an arrow's endpoint.
    onPreview: (points: Point[] | null, index: number) => void;
    // One sealed write of the reshaped points on release, with the dragged vertex index.
    onCommit: (points: Point[], index: number) => void;
    // The currently point-selected vertex index (null = none) — that dot renders filled; the host
    // deletes THIS point on Delete/Backspace.
    selectedIndex: number | null;
    // Select a vertex (or clear with null): fired on a vertex pointerdown (click or drag start) and on
    // drag release (so a reshaped/inserted vertex stays selected). Midpoint dots never select on press —
    // only on their release, once the insert has actually landed.
    onSelect: (index: number | null) => void;
};

export function LinePointHandles({
    line,
    zoom,
    boxToStyle,
    clientToScene,
    frozenRef,
    onPreview,
    onCommit,
    selectedIndex,
    onSelect,
}: LinePointHandlesProps) {
    // The drag in flight: the base points it moves through (the original set for a vertex drag, or the
    // original set with the inserted vertex for a midpoint drag), the moving index, and its live local
    // position so the grabbed handle follows the cursor.
    const [drag, setDrag] = useState<{ base: Point[]; index: number; local: Point } | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    // If the element is deleted (e.g. a remote peer) mid-drag, the component unmounts before pointerup —
    // tear the document listeners down so they don't linger. The host clears its own draft state (below).
    useEffect(() => () => abortRef.current?.abort(), []);
    const points = parsePoints(line.points);
    // Elbow arrows store only the two endpoints and derive their bends — no midpoint insert here.
    const isElbow = line.type === 'arrow' && line.elbow;

    // Begin dragging `index` through `base`. `insert` gates the drag behind a small travel threshold
    // (a midpoint that must not fire on a plain click); an existing-vertex drag is live from move one.
    const startDrag = (e: React.PointerEvent, base: Point[], index: number, insert: boolean) => {
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
        // A midpoint drag stays inert until the pointer travels; then it becomes a live vertex drag.
        let active = !insert;
        let latest: Point[] | null = null;

        const update = (clientX: number, clientY: number) => {
            const local = linearSceneToLocal(line, clientToScene(clientX, clientY));
            const next = base.map((p, i) => (i === index ? local : p));
            latest = next;
            setDrag({ base, index, local });
            onPreview(next, index);
        };
        const teardown = () => {
            setDrag(null);
            frozenRef.current = false;
            controller.abort();
        };
        const onMove = (me: PointerEvent) => {
            if (me.pointerId !== pointerId) return;
            if (!active) {
                if (Math.hypot(me.clientX - startX, me.clientY - startY) < MIDPOINT_DRAG_THRESHOLD_PX) return;
                active = true;
            }
            update(me.clientX, me.clientY);
        };
        const onUp = (pe: PointerEvent) => {
            if (pe.pointerId !== pointerId) return;
            teardown();
            // A midpoint click that never travelled leaves `latest` null → nothing is inserted.
            if (latest) {
                onCommit(latest, index);
                // Leave the dragged vertex selected on release (a midpoint drag selects the vertex it
                // just inserted), so Delete pressed immediately after acts on THIS point.
                onSelect(index);
            } else onPreview(null, index);
        };
        const onKey = (ke: KeyboardEvent) => {
            if (ke.key !== 'Escape') return;
            ke.preventDefault();
            ke.stopPropagation();
            teardown();
            // Cancels the whole gesture — a mid-insert drag drops the inserted vertex too.
            onPreview(null, index);
        };
        document.addEventListener('pointermove', onMove, { signal });
        document.addEventListener('pointerup', onUp, { signal });
        document.addEventListener('pointercancel', onUp, { signal });
        document.addEventListener('keydown', onKey, { signal, capture: true });
    };

    // During a drag the base set (with any inserted vertex) is the source of truth; idle, it's the
    // stored points. Midpoint dots are hidden mid-drag so they never sit on a stale segment.
    const vertices = drag ? drag.base : points;

    // Position a dot centred on a local point, in the host's screen frame — its 22px hit area / 20px hover
    // halo / dot size all come from the .eigen-*-handle CSS token (D9), so the JSX only places it.
    const dotStyle = (local: Point): React.CSSProperties => {
        const scene = linearLocalToScene(line, local);
        const { left, top } = boxToStyle({ x: scene.x, y: scene.y, width: 0, height: 0, angle: 0 });
        return { left, top, transform: 'translate(-50%, -50%)' };
    };

    // The vertex position a dot renders at (its live drag position for the grabbed one).
    const vertexLocal = (i: number, p: Point) => (drag?.index === i ? drag.local : p);
    // Overlap merge (D9(d)): a vertex within OVERLAP_MERGE_SCREEN_PX of a HIGHER-index neighbour is hidden
    // into it, and that neighbour draws doubled — so coincident points read as one dot and a click resolves
    // to the higher (top-most) index. Suppressed mid-drag, where the grabbed vertex has left its neighbours.
    const mergeGap = OVERLAP_MERGE_SCREEN_PX / zoom;
    const hiddenVertex = (i: number): boolean =>
        !drag &&
        i < vertices.length - 1 &&
        Math.hypot(
            vertexLocal(i, vertices[i]).x - vertices[i + 1].x,
            vertexLocal(i, vertices[i]).y - vertices[i + 1].y,
        ) <= mergeGap;
    const doubledVertex = (i: number): boolean => !drag && i > 0 && hiddenVertex(i - 1);

    return (
        <>
            {vertices.map((p, i) =>
                hiddenVertex(i) ? null : (
                    <div
                        key={`v${i}`}
                        className={`eigen-vertex-handle pointer-events-auto touch-none cursor-pointer${
                            selectedIndex === i ? ' eigen-vertex-handle-selected' : ''
                        }${doubledVertex(i) ? ' eigen-point-handle-doubled' : ''}${drag ? ' eigen-point-handle-no-halo' : ''}`}
                        style={dotStyle(vertexLocal(i, p))}
                        // Click selects THIS point (a following drag reshapes it and keeps it selected).
                        onPointerDown={(e) => {
                            onSelect(i);
                            startDrag(e, points, i, false);
                        }}
                    />
                ),
            )}
            {!drag &&
                !isElbow &&
                points.slice(0, -1).map((p, i) => {
                    const next = points[i + 1];
                    // Hide the midpoint dot on a segment too short to be worth one (D9(c)) — screen length.
                    if (Math.hypot(next.x - p.x, next.y - p.y) * zoom < MIDPOINT_MIN_SEGMENT_SCREEN_PX) return null;
                    const mid = { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 };
                    // The vertex this dot would insert, at index i+1 between its two neighbours.
                    const base = [...points.slice(0, i + 1), mid, ...points.slice(i + 1)];
                    return (
                        <div
                            key={`m${i}`}
                            className="eigen-midpoint-handle pointer-events-auto touch-none cursor-pointer"
                            style={dotStyle(mid)}
                            onPointerDown={(e) => startDrag(e, base, i + 1, true)}
                        />
                    );
                })}
        </>
    );
}
