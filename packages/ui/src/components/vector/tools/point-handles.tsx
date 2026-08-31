// Draggable vertex handles for a single selected line/arrow (R2.13) — round `.eigen-vertex-handle`
// dots, one per point, visually distinct from the square resize grips (a 2-point line/arrow shows
// these ONLY, with no ObjectTransform box). Dragging a vertex reshapes the line through normalizeLinear
// as one sealed undo step; there is no vertex add/remove in v1 (midpoint drag-to-add is UA3, so no
// dead midpoint dot is drawn). Self-contained like ObjectTransform: it owns its drag lifecycle
// (document listeners under an AbortController) and reports the live points via `onPreview`, committing
// once on release. Freedraw shows no handles.

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
import { useRef, useState } from 'react';

// Screen diameter of a vertex dot (Excalidraw's POINT_HANDLE_SIZE), overriding the 12px ring grip.
const POINT_HANDLE_SCREEN_PX = 10;

type LinePointHandlesProps = {
    // A line or an arrow — both carry `points`; an arrow's endpoint drag additionally (re)binds (R3.10),
    // which the host resolves from the dragged vertex index.
    line: VectorLinearElement | VectorArrowElement;
    boxToStyle: (box: Box) => React.CSSProperties;
    clientToScene: (clientX: number, clientY: number) => Point;
    frozenRef: MutableRefObject<boolean>;
    // Live points during a drag (null clears the preview) and the vertex index being dragged; the host
    // renders the reshaped element and highlights a binding candidate under an arrow's endpoint.
    onPreview: (points: Point[] | null, index: number) => void;
    // One sealed write of the reshaped points on release, with the dragged vertex index.
    onCommit: (points: Point[], index: number) => void;
};

export function LinePointHandles({
    line,
    boxToStyle,
    clientToScene,
    frozenRef,
    onPreview,
    onCommit,
}: LinePointHandlesProps) {
    // The vertex being dragged and its live local position, so the grabbed handle follows the cursor.
    const [drag, setDrag] = useState<{ index: number; local: Point } | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const points = parsePoints(line.points);

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
        let latest: Point[] | null = null;

        const update = (clientX: number, clientY: number) => {
            const local = linearSceneToLocal(line, clientToScene(clientX, clientY));
            const next = points.map((p, i) => (i === index ? local : p));
            latest = next;
            setDrag({ index, local });
            onPreview(next, index);
        };
        const teardown = () => {
            setDrag(null);
            frozenRef.current = false;
            controller.abort();
        };
        const onMove = (me: PointerEvent) => {
            if (me.pointerId !== pointerId) return;
            update(me.clientX, me.clientY);
        };
        const onUp = (pe: PointerEvent) => {
            if (pe.pointerId !== pointerId) return;
            teardown();
            if (latest) onCommit(latest, index);
            else onPreview(null, index);
        };
        const onKey = (ke: KeyboardEvent) => {
            if (ke.key !== 'Escape') return;
            ke.preventDefault();
            ke.stopPropagation();
            teardown();
            onPreview(null, index);
        };
        document.addEventListener('pointermove', onMove, { signal });
        document.addEventListener('pointerup', onUp, { signal });
        document.addEventListener('pointercancel', onUp, { signal });
        document.addEventListener('keydown', onKey, { signal, capture: true });
    };

    return (
        <>
            {points.map((p, i) => {
                const local = drag?.index === i ? drag.local : p;
                const scene = linearLocalToScene(line, local);
                const style = boxToStyle({ x: scene.x, y: scene.y, width: 0, height: 0, angle: 0 });
                return (
                    <div
                        key={i}
                        className="eigen-vertex-handle pointer-events-auto touch-none cursor-pointer"
                        style={{
                            left: style.left,
                            top: style.top,
                            width: POINT_HANDLE_SCREEN_PX,
                            height: POINT_HANDLE_SCREEN_PX,
                            transform: 'translate(-50%, -50%)',
                        }}
                        onPointerDown={(e) => startDrag(e, i)}
                    />
                );
            })}
        </>
    );
}
