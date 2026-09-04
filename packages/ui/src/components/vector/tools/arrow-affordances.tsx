// Drag-time attach affordances for arrows, drawn in the scene group next to the bind-target outline
// (the snap dots and the straight-arrow focus point). Pulled out of canvas-editor.tsx and use-drawing-tools
// (the canvas only dispatches; this unit owns its own render) so neither file grows. All geometry is SCENE
// space — the group scales by zoom, so screen-constant sizes divide by zoom and stroke widths ride
// `vectorEffect="non-scaling-stroke"`, exactly as SnapGuides does. Colours are ours (the selection-handle
// accent), the geometry/sizes are Excalidraw's (interactiveScene.ts).

import {
    anchorToScene,
    type Box,
    bindingAnchor,
    bindingDistance,
    boundEndpoint,
    focusSnapPoint,
    isBindable,
    type Point,
    parseBinding,
    parsePoints,
    shapeAnchorPoints,
    type VectorArrowElement,
    type VectorBindableElement,
    type VectorElement,
} from '@workspace/lib/vector';
import type { MutableRefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { pointInsideShape } from './binding';

// Screen radius of a side-midpoint snap dot (Excalidraw's 4 / zoom).
const SNAP_DOT_SCREEN_R = 4;
// Excalidraw's FOCUS_POINT_SIZE — the focus circle is FOCUS_POINT_SIZE / 1.5 / 1.5 ≈ 4.44 px, and the
// indicator hides once the anchor sits within FOCUS_POINT_SIZE · 1.5 px of its own endpoint (isFocusPointVisible).
const FOCUS_POINT_SIZE = 10;
const FOCUS_CIRCLE_SCREEN_R = FOCUS_POINT_SIZE / 1.5 / 1.5;
const FOCUS_MIN_SCREEN_GAP = FOCUS_POINT_SIZE * 1.5;
// The focus GRAB ring only claims the pointer once the anchor clears the endpoint's own ~22px grab radius —
// in the 15-22px overlap zone the ENDPOINT drag takes precedence (Excalidraw's "endpoint dragging takes
// precedence"). The dashed INDICATOR still shows from FOCUS_MIN_SCREEN_GAP; only the grab is gated wider.
const FOCUS_GRAB_MIN_SCREEN_GAP = 22;
// Screen radius of the solid dock dot at a bound straight endpoint.
const FOCUS_DOCK_SCREEN_R = 4;

function dist(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampUnit(n: number): number {
    return Math.min(1, Math.max(0, n));
}

// The side-midpoint snap dots over a bind candidate: all four rendered, the one nearest the pointer
// within bindingDistance + strokeWidth/2 filled in the accent, the rest ghosted. For a NON-elbow arrow the
// dots are suppressed while the cursor is buried inside the shape (Excalidraw's !isPointInElement); for an
// elbow arrow all four always show, even inside.
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
    // Excalidraw draws nothing when the cursor is buried inside a NON-elbow bindable (interactiveScene's
    // `!cursorIsInsideBindable || isElbow` gate); an elbow always draws.
    if (!elbow && pointInsideShape(shape, pointer)) return null;
    const mids = shapeAnchorPoints(shape);
    const r = SNAP_DOT_SCREEN_R / zoom;
    const highlightWithin = bindingDistance(zoom) + shape.strokeWidth / 2;
    // The dot nearest the pointer is the one the dock will snap to.
    let nearest = -1;
    let nearestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < mids.length; i++) {
        const d = dist(mids[i], pointer);
        if (d < nearestDist) {
            nearestDist = d;
            nearest = i;
        }
    }
    // Elbow: all four dots, the nearest within the band filled, the rest ghosted. Non-elbow: ONLY the
    // nearest dot, filled within the band or ghosted within 2× it, nothing beyond (interactiveScene:540-552).
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

// One bound end worth showing a focus affordance for: the anchor the arrow aims at (inside the shape) and
// the endpoint it docks to (on the outline). `anchor` is read from the LIVE arrow (the preview element while
// a focus drag re-aims it), so the dashed line + dot track the drag.
type FocusEnd = { end: 'start' | 'end'; shape: VectorBindableElement; anchor: Point; endpoint: Point };

// The bound ends of a straight 2-point arrow that should show a focus point, skipping `hideEnd` (the end
// being endpoint-dragged) and any end whose anchor has all but collapsed onto its endpoint
// (isFocusPointVisible's distance gate). Shared by the SVG indicators and the DOM grab handles so both agree
// on which dots exist and where.
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
        const endpoint = boundEndpoint(arrow, end, shape);
        if (dist(anchor, endpoint) * zoom < minScreenGap) continue;
        out.push({ end, shape, anchor, endpoint });
    }
    return out;
}

// The focus-point affordance for a selected bound STRAIGHT arrow, per bound end: a solid dock dot on
// the shape outline (the endpoint) and a dashed line to the hollow anchor dot inside the shape, so the
// distinction between "the anchor the arrow aims at" and "the endpoint on the outline" is visible and the
// release orbit reads as intended rather than a jump. Never for elbow arrows (their endpoint IS the anchor).
// The hollow dot is a DRAGGABLE grab target (FocusPointHandles, a DOM overlay); this is its screen-constant
// SVG face, drawn in the scene group so it rides rotation/zoom.
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

// The draggable grab targets over each focus point: a transparent ~22px DOM ring over the SVG
// hollow anchor dot, so the aim point can be grabbed with the same generous target as a vertex handle. Its
// pointerdown claims the gesture BEFORE the canvas hit-test (capture + stopPropagation, exactly as the vertex
// handles do) so grabbing the dot re-aims the binding rather than dragging the shape underneath. Dragging
// moves the aim live: fixedPoint = the cursor's anchor ratio clamped to the shape's inside ([0,1]); the
// endpoint re-derives through the chord (the host's preview element), the dashed line + dots track. Release
// commits ONE sealed step storing the RAW dragged aim — Excalidraw does not re-project a focus-point drag
// (handleFocusPointDrag stores the raw ratio; the diagonal projection is a bind-time-only nicety). Escape
// cancels. Self-contained like LinePointHandles: it owns its drag lifecycle under an AbortController.
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
    // Live aim during a drag (null clears the preview) — the host re-binds the dragged end to `fixedPoint`
    // and re-derives its endpoint, so the drawn arrow + this handle both track.
    onPreview: (end: 'start' | 'end', fixedPoint: [number, number] | null, pointer?: Point) => void;
    // One sealed write of the new aim on release.
    onCommit: (end: 'start' | 'end', fixedPoint: [number, number]) => void;
}) {
    // The end being dragged and its live anchor position, so the grabbed dot follows the cursor without
    // waiting on the parent's preview round-trip (mirrors LinePointHandles' `drag.local`).
    const [drag, setDrag] = useState<{ end: 'start' | 'end'; anchor: Point } | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => () => abortRef.current?.abort(), []);

    // Grab handles claim the pointer only past the wider gap, so the endpoint wins the 15-22px overlap zone.
    const ends = focusEnds(arrow, byId, zoom, hideEnd, FOCUS_GRAB_MIN_SCREEN_GAP);
    if (ends.length === 0) return null;

    const startDrag = (e: React.PointerEvent, end: 'start' | 'end', shape: VectorBindableElement) => {
        e.preventDefault();
        // Claim the gesture before the canvas hit-test so the shape under the dot isn't dragged instead.
        e.stopPropagation();
        if (abortRef.current && !abortRef.current.signal.aborted) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        frozenRef.current = true;
        const controller = new AbortController();
        abortRef.current = controller;
        const { signal } = controller;
        const pointerId = e.pointerId;
        let latest: [number, number] | null = null;

        const update = (clientX: number, clientY: number, suppressed: boolean) => {
            const scene = clientToScene(clientX, clientY);
            // Eigen extension: magnet the aim onto the shape's snap points (side midpoints + centre),
            // unless Ctrl/Cmd suppresses it — consistent with every other bind/snap here. The raw pointer is
            // still handed up so the host lights the SnapDots (the nearest side-midpoint highlights).
            const snapped = suppressed ? scene : (focusSnapPoint(shape, scene, zoom) ?? scene);
            const [rx, ry] = bindingAnchor(shape, snapped);
            const fixedPoint: [number, number] = [clampUnit(rx), clampUnit(ry)];
            latest = fixedPoint;
            setDrag({ end, anchor: anchorToScene(shape, fixedPoint) });
            onPreview(end, fixedPoint, scene);
        };
        const teardown = () => {
            setDrag(null);
            frozenRef.current = false;
            controller.abort();
        };
        const onMove = (me: PointerEvent) => {
            if (me.pointerId !== pointerId) return;
            update(me.clientX, me.clientY, me.ctrlKey || me.metaKey);
        };
        const onUp = (pe: PointerEvent) => {
            if (pe.pointerId !== pointerId) return;
            teardown();
            // A click that never moved leaves `latest` null → commit nothing (no spurious re-bind).
            if (latest) onCommit(end, latest);
            else onPreview(end, null);
        };
        const onKey = (ke: KeyboardEvent) => {
            if (ke.key !== 'Escape') return;
            ke.preventDefault();
            ke.stopPropagation();
            teardown();
            onPreview(end, null);
        };
        document.addEventListener('pointermove', onMove, { signal });
        document.addEventListener('pointerup', onUp, { signal });
        document.addEventListener('pointercancel', onUp, { signal });
        document.addEventListener('keydown', onKey, { signal, capture: true });
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
                    className={`eigen-focus-handle pointer-events-auto touch-none cursor-pointer${
                        drag ? ' eigen-point-handle-no-halo' : ''
                    }`}
                    style={dotStyle(drag?.end === end ? drag.anchor : anchor)}
                    onPointerDown={(e) => startDrag(e, end, shape)}
                />
            ))}
        </>
    );
}
