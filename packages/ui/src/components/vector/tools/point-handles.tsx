// The round vertex dots of a selected line or arrow, and a translucent midpoint dot between each pair of them. A click
// selects a vertex for Delete; a drag reshapes the line and commits once on release, as one undo step. Dragging a
// midpoint dot inserts a vertex there, a plain click on it adds nothing, and Escape drops the insert. The host
// renders the live points through `onPreview`. Elbow arrows show only their endpoints, as their bends are routed.

import type { Box, Point, VectorArrowElement, VectorLinearElement } from '@workspace/lib/vector';
import { linearLocalToScene, linearSceneToLocal, parsePoints } from '@workspace/lib/vector';
import type { MutableRefObject } from 'react';
import { useState } from 'react';
import { usePointerDrag } from '../../../hooks/use-pointer-drag';
import { cn } from '../../../lib/utils';

// Client px a midpoint press travels before it inserts, so a plain click adds nothing (Excalidraw's value).
const MIDPOINT_DRAG_THRESHOLD_PX = 2;
// A segment shorter than this on screen shows no midpoint dot, so short segments don't clutter (Excalidraw's).
const MIDPOINT_MIN_SEGMENT_SCREEN_PX = 40;
// Two adjacent vertices this close on screen draw as one doubled dot, so a click takes the top-most, higher index.
const OVERLAP_MERGE_SCREEN_PX = 2;

type LinePointHandlesProps = {
    line: VectorLinearElement | VectorArrowElement;
    zoom: number;
    boxToStyle: (box: Box) => React.CSSProperties;
    clientToScene: (clientX: number, clientY: number) => Point;
    frozenRef: MutableRefObject<boolean>;
    // Null clears the preview.
    onPreview: (points: Point[] | null, index: number) => void;
    onCommit: (points: Point[], index: number) => void;
    selectedIndex: number | null;
    // A midpoint dot selects only on release, once its insert has landed.
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
    // `base` holds the inserted vertex during a midpoint drag; `local` lets the grabbed dot follow the cursor.
    const [drag, setDrag] = useState<{ base: Point[]; index: number; local: Point } | null>(null);
    const startPointerDrag = usePointerDrag(frozenRef);
    const points = parsePoints(line.points);
    const isElbow = line.type === 'arrow' && line.elbow;

    const startDrag = (e: React.PointerEvent, base: Point[], index: number, insert: boolean) => {
        let latest: Point[] | null = null;
        startPointerDrag(e, {
            threshold: insert ? MIDPOINT_DRAG_THRESHOLD_PX : 0,
            move: (me) => {
                const local = linearSceneToLocal(line, clientToScene(me.clientX, me.clientY));
                const next = base.map((p, i) => (i === index ? local : p));
                latest = next;
                setDrag({ base, index, local });
                onPreview(next, index);
            },
            end: () => {
                setDrag(null);
                if (latest) {
                    onCommit(latest, index);
                    onSelect(index);
                } else onPreview(null, index);
            },
            cancel: () => {
                setDrag(null);
                onPreview(null, index);
            },
        });
    };

    // Midpoint dots hide mid-drag, so they never sit on a stale segment.
    const vertices = drag ? drag.base : points;

    // The dot's size and hit area come from its .eigen-*-handle CSS class; this only places it.
    const dotStyle = (local: Point): React.CSSProperties => {
        const scene = linearLocalToScene(line, local);
        const { left, top } = boxToStyle({ x: scene.x, y: scene.y, width: 0, height: 0, angle: 0 });
        return { left, top, transform: 'translate(-50%, -50%)' };
    };

    const vertexLocal = (i: number, p: Point) => (drag?.index === i ? drag.local : p);
    // No merge mid-drag, where the grabbed vertex has left its neighbors.
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
                (isElbow && i !== 0 && i !== vertices.length - 1) || hiddenVertex(i) ? null : (
                    <div
                        key={`v${i}`}
                        className={cn(
                            'eigen-vertex-handle pointer-events-auto touch-none cursor-pointer',
                            selectedIndex === i && 'eigen-vertex-handle-selected',
                            doubledVertex(i) && 'eigen-point-handle-doubled',
                            drag && 'eigen-point-handle-no-halo',
                        )}
                        style={dotStyle(vertexLocal(i, p))}
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
                    if (Math.hypot(next.x - p.x, next.y - p.y) * zoom < MIDPOINT_MIN_SEGMENT_SCREEN_PX) return null;
                    const mid = { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 };
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
