// The segment-pin dots of a selected elbow arrow, one on every long-enough segment of its route. Dragging a dot pins
// that segment and slides it along its axis; the first pin freezes the derived route into stored points, and an end
// segment gains a jog so the pinned one turns interior. Double-click or Delete unpins. A pin is keyed by its polyline
// index, never by geometry, so a dot always knows whether its segment is pinned. The host previews and commits.

import type { Box, FixedSegment, PinPatch, PinRoutingContext, Point, VectorArrowElement } from '@workspace/lib/vector';
import { materializeFirstPin, moveSegment, parseFixedSegments, unpinSegment } from '@workspace/lib/vector';
import { cn } from '@workspace/ui/lib/utils';
import type { MutableRefObject } from 'react';
import { usePointerDrag } from '../../../hooks/use-pointer-drag';

// Client px a pin press travels before it pins, so a click never does.
const PIN_DRAG_THRESHOLD_PX = 2;
// A segment shorter than this on screen shows no dot, the same gate as a line's midpoint dots.
const PIN_MIN_SEGMENT_SCREEN_PX = 40;

type ElbowPinHandlesProps = {
    arrow: VectorArrowElement;
    // In the arrow's local frame; the dot on segment i keys polyline index i+1.
    route: Point[];
    // Resolved by the host, so this overlay and the pin math stay pure.
    context: PinRoutingContext;
    zoom: number;
    boxToStyle: (box: Box) => React.CSSProperties;
    clientToScene: (clientX: number, clientY: number) => Point;
    frozenRef: MutableRefObject<boolean>;
    // Null clears the preview.
    onPreview: (patch: PinPatch | null) => void;
    onCommit: (patch: PinPatch) => void;
    selectedPinIndex: number | null;
    onSelectPin: (index: number | null) => void;
};

export function ElbowPinHandles({
    arrow,
    route,
    context,
    zoom,
    boxToStyle,
    clientToScene,
    frozenRef,
    onPreview,
    onCommit,
    selectedPinIndex,
    onSelectPin,
}: ElbowPinHandlesProps) {
    const startPointerDrag = usePointerDrag(frozenRef);

    const pins: FixedSegment[] = parseFixedSegments(arrow.fixedSegments).segments;
    const isPinned = (index: number): boolean => pins.some((p) => p.index === index);

    const startDrag = (e: React.PointerEvent, index: number) => {
        let latest: PinPatch | null = null;
        startPointerDrag(e, {
            threshold: PIN_DRAG_THRESHOLD_PX,
            move: (me) => {
                const cursor = clientToScene(me.clientX, me.clientY);
                latest =
                    arrow.fixedSegments === ''
                        ? materializeFirstPin(arrow, route, index, cursor, context)
                        : moveSegment(arrow, index, cursor, context);
                onPreview(latest);
            },
            end: () => {
                if (latest !== null) onCommit(latest);
                else onPreview(null);
            },
            cancel: () => onPreview(null),
        });
    };

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
                const b = route[i + 1];
                if (Math.hypot(b.x - a.x, b.y - a.y) * zoom < PIN_MIN_SEGMENT_SCREEN_PX) return null;
                const index = i + 1;
                const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                const pinned = isPinned(index);
                return (
                    <div
                        key={`p${index}`}
                        className={cn(
                            'eigen-midpoint-handle pointer-events-auto touch-none cursor-pointer',
                            pinned && 'eigen-point-handle-doubled',
                            selectedPinIndex === index && 'eigen-vertex-handle-selected',
                        )}
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
