// The attach affordances of an arrow, such as the snap dots over a bind target and the focus point a bound straight
// arrow aims at, which a drag re-aims. Drawn in scene space beside the bind-target outline: the group scales by zoom,
// so screen-constant sizes divide by zoom and strokes use `non-scaling-stroke`. The canvas only places them. The
// sizes are Excalidraw's, the colors the selection-handle accent.

import type { Box, Point, VectorArrowElement, VectorBindableElement, VectorElement } from '@workspace/lib/vector';
import {
    anchorToScene,
    bindingAnchor,
    bindingDistance,
    boundEndpoint,
    distance,
    focusSnapPoint,
    isBindable,
    parseBinding,
    parsePoints,
    shapeAnchorPoints,
} from '@workspace/lib/vector';
import { cn } from '@workspace/ui/lib/utils';
import type { MutableRefObject } from 'react';
import { useState } from 'react';
import { usePointerDrag } from '../../../hooks/use-pointer-drag';
import { pointInsideShape } from './binding';

// Screen radius of a side-midpoint snap dot (Excalidraw's 4 / zoom).
const SNAP_DOT_SCREEN_R = 4;
// Excalidraw's focus point size; the dot's radius and the gap under which the indicator hides derive from it.
const FOCUS_POINT_SIZE = 10;
const FOCUS_CIRCLE_SCREEN_R = FOCUS_POINT_SIZE / 1.5 / 1.5;
const FOCUS_MIN_SCREEN_GAP = FOCUS_POINT_SIZE * 1.5;
// The endpoint's own grab radius: closer than this the endpoint drag wins, as in Excalidraw, while the
// indicator still shows from FOCUS_MIN_SCREEN_GAP.
const FOCUS_GRAB_MIN_SCREEN_GAP = 22;
// Screen radius of the solid dock dot at a bound straight endpoint.
const FOCUS_DOCK_SCREEN_R = 4;

function clampUnit(n: number): number {
    return Math.min(1, Math.max(0, n));
}

// The side-midpoint snap dots over a bind candidate, the one nearest the pointer filled in the accent. A straight
// arrow draws none while the pointer is inside the shape, as Excalidraw does; an elbow arrow always draws.
export function SnapDots({
    shape,
    pointer,
    zoom,
    elbow,
}: {
    shape: VectorBindableElement;
    pointer: Point;
    zoom: number;
    elbow: boolean;
}) {
    if (!elbow && pointInsideShape(shape, pointer)) return null;
    const mids = shapeAnchorPoints(shape);
    const r = SNAP_DOT_SCREEN_R / zoom;
    const highlightWithin = bindingDistance(zoom) + shape.strokeWidth / 2;
    // The dot nearest the pointer is the one the dock will snap to.
    let nearest = -1;
    let nearestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < mids.length; i++) {
        const d = distance(mids[i], pointer);
        if (d < nearestDist) {
            nearestDist = d;
            nearest = i;
        }
    }
    // Elbow: all four dots, the nearest within the band filled, the rest ghosted. Non-elbow: ONLY the
    // nearest dot, filled within the band or ghosted within 2× it, nothing beyond, as Excalidraw does.
    return (
        <>
            {mids.map((m, i) => {
                const highlighted = i === nearest && nearestDist <= highlightWithin;
                const shown = !highlighted && (elbow || (i === nearest && nearestDist <= highlightWithin * 2));
                if (!highlighted && !shown) return null;
                return (
                    <circle
                        key={i}
                        className="fill-selection-handle"
                        cx={m.x}
                        cy={m.y}
                        r={r}
                        opacity={highlighted ? 1 : 0.35}
                    />
                );
            })}
        </>
    );
}

// `anchor` is where the arrow aims, inside the shape, read from the live arrow so it tracks a focus drag;
// `endpoint` is where it docks on the outline.
type FocusEnd = { end: 'start' | 'end'; shape: VectorBindableElement; anchor: Point; endpoint: Point };

// The bound ends of a straight two-point arrow that show a focus point, so the indicators and the grab handles
// agree. `hideEnd` is the end being endpoint-dragged.
function focusEnds(
    arrow: VectorArrowElement,
    byId: Map<string, VectorElement>,
    zoom: number,
    hideEnd: 'start' | 'end' | null,
    minScreenGap: number = FOCUS_MIN_SCREEN_GAP,
): FocusEnd[] {
    if (arrow.elbow || parsePoints(arrow.points).length !== 2) return [];
    const out: FocusEnd[] = [];
    for (const end of ['start', 'end'] as const) {
        if (end === hideEnd) continue;
        const binding = parseBinding(end === 'start' ? arrow.startBinding : arrow.endBinding);
        if (!binding) continue;
        const shape = byId.get(binding.elementId);
        if (!shape || !isBindable(shape)) continue;
        const anchor = anchorToScene(shape, binding.fixedPoint);
        const endpoint = boundEndpoint(arrow, end, shape, byId);
        if (distance(anchor, endpoint) * zoom < minScreenGap) continue;
        out.push({ end, shape, anchor, endpoint });
    }
    return out;
}

// Per bound end of a selected straight arrow, a solid dot where it docks and a dashed line to a hollow dot where it
// aims, so a release that orbits the arrow reads as intended rather than a jump. An elbow arrow docks where it aims.
export function FocusIndicators({
    arrow,
    byId,
    zoom,
    hideEnd,
}: {
    arrow: VectorArrowElement;
    byId: Map<string, VectorElement>;
    zoom: number;
    hideEnd: 'start' | 'end' | null;
}) {
    const ends = focusEnds(arrow, byId, zoom, hideEnd);
    if (ends.length === 0) return null;
    return (
        <>
            {ends.map(({ end, anchor, endpoint }) => (
                <g key={end}>
                    <line
                        className="stroke-selection-handle"
                        x1={endpoint.x}
                        y1={endpoint.y}
                        x2={anchor.x}
                        y2={anchor.y}
                        strokeWidth={1}
                        strokeDasharray="4 4"
                        opacity={0.6}
                        vectorEffect="non-scaling-stroke"
                    />
                    <circle
                        className="fill-selection-handle"
                        cx={endpoint.x}
                        cy={endpoint.y}
                        r={FOCUS_DOCK_SCREEN_R / zoom}
                    />
                    <circle
                        className="fill-background stroke-selection-handle"
                        cx={anchor.x}
                        cy={anchor.y}
                        r={FOCUS_CIRCLE_SCREEN_R / zoom}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                    />
                </g>
            ))}
        </>
    );
}

// A transparent DOM ring over each focus point's hollow dot, as generous a target as a vertex handle. Dragging it
// re-aims the binding live, clamped inside the shape, and release stores the raw aim as one undo step: Excalidraw
// re-projects the aim only when an arrow binds, never on a focus-point drag.
export function FocusPointHandles({
    arrow,
    byId,
    zoom,
    hideEnd,
    boxToStyle,
    clientToScene,
    frozenRef,
    onPreview,
    onCommit,
}: {
    arrow: VectorArrowElement;
    byId: Map<string, VectorElement>;
    zoom: number;
    hideEnd: 'start' | 'end' | null;
    boxToStyle: (box: Box) => React.CSSProperties;
    clientToScene: (clientX: number, clientY: number) => Point;
    frozenRef: MutableRefObject<boolean>;
    // Null clears the preview.
    onPreview: (end: 'start' | 'end', fixedPoint: [number, number] | null, pointer?: Point) => void;
    onCommit: (end: 'start' | 'end', fixedPoint: [number, number]) => void;
}) {
    // The grabbed dot follows the cursor without waiting on the host's preview round-trip.
    const [drag, setDrag] = useState<{ end: 'start' | 'end'; anchor: Point } | null>(null);
    const startPointerDrag = usePointerDrag(frozenRef);

    // Grab handles claim the pointer only past the wider gap, so the endpoint wins the 15-22px overlap zone.
    const ends = focusEnds(arrow, byId, zoom, hideEnd, FOCUS_GRAB_MIN_SCREEN_GAP);
    if (ends.length === 0) return null;

    const startDrag = (e: React.PointerEvent, end: 'start' | 'end', shape: VectorBindableElement) => {
        let latest: [number, number] | null = null;
        startPointerDrag(e, {
            threshold: 0,
            move: (me) => {
                const scene = clientToScene(me.clientX, me.clientY);
                // Our addition to Excalidraw: the aim snaps to the shape's snap points unless Ctrl or Cmd is
                // held, as every other bind does. The raw pointer still goes up, so the host lights the SnapDots.
                const suppressed = me.ctrlKey || me.metaKey;
                const snapped = suppressed ? scene : (focusSnapPoint(shape, scene, zoom) ?? scene);
                const [rx, ry] = bindingAnchor(shape, snapped);
                const fixedPoint: [number, number] = [clampUnit(rx), clampUnit(ry)];
                latest = fixedPoint;
                setDrag({ end, anchor: anchorToScene(shape, fixedPoint) });
                onPreview(end, fixedPoint, scene);
            },
            end: () => {
                setDrag(null);
                if (latest) onCommit(end, latest);
                else onPreview(end, null);
            },
            cancel: () => {
                setDrag(null);
                onPreview(end, null);
            },
        });
    };

    const dotStyle = (scene: Point): React.CSSProperties => {
        const { left, top } = boxToStyle({ x: scene.x, y: scene.y, width: 0, height: 0, angle: 0 });
        return { left, top };
    };

    return (
        <>
            {ends.map(({ end, shape, anchor }) => (
                <div
                    key={end}
                    className={cn(
                        'eigen-focus-handle pointer-events-auto touch-none cursor-pointer',
                        drag && 'eigen-point-handle-no-halo',
                    )}
                    style={dotStyle(drag?.end === end ? drag.anchor : anchor)}
                    onPointerDown={(e) => startDrag(e, end, shape)}
                />
            ))}
        </>
    );
}
