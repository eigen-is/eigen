// Drag-time attach affordances for arrows, drawn in the scene group next to the bind-target outline
// (B2 snap dots, B4/D5 straight-arrow focus point). Pulled out of vector-canvas.tsx and use-drawing-tools
// (the canvas only dispatches; this unit owns its own render) so neither file grows. All geometry is SCENE
// space — the group scales by zoom, so screen-constant sizes divide by zoom and stroke widths ride
// `vectorEffect="non-scaling-stroke"`, exactly as SnapGuides does. Colours are ours (the selection-handle
// accent), the geometry/sizes are Excalidraw's (interactiveScene.ts).

import {
    anchorToScene,
    bindingDistance,
    boundEndpoint,
    boxCenter,
    type Point,
    parseBinding,
    parsePoints,
    rotatePoint,
    type VectorArrowElement,
    type VectorElement,
    type VectorShapeElement,
} from '@workspace/lib/vector';
import { pointInsideShape } from './binding';

// Screen radius of a side-midpoint snap dot (Excalidraw's 4 / zoom).
const SNAP_DOT_SCREEN_R = 4;
// Excalidraw's FOCUS_POINT_SIZE — the focus circle is FOCUS_POINT_SIZE / 1.5 / 1.5 ≈ 4.44 px, and the
// indicator hides once the anchor sits within FOCUS_POINT_SIZE · 1.5 px of its own endpoint (isFocusPointVisible).
const FOCUS_POINT_SIZE = 10;
const FOCUS_CIRCLE_SCREEN_R = FOCUS_POINT_SIZE / 1.5 / 1.5;
const FOCUS_MIN_SCREEN_GAP = FOCUS_POINT_SIZE * 1.5;
// Screen radius of the solid dock dot at a bound straight endpoint.
const FOCUS_DOCK_SCREEN_R = 4;

function dist(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// The four side midpoints of a shape in scene space (rect/ellipse: the edge midpoints of the box, which
// for an ellipse are its top/right/bottom/left extremes; diamond: the midpoints of its four slanted
// edges), rotated by the shape's angle — the exact points snapToMid docks onto, so the dots are truthful.
function sideMidpoints(shape: VectorShapeElement): Point[] {
    const { x, y, width: w, height: h } = shape;
    const local =
        shape.type === 'diamond'
            ? [
                  { x: x + (3 * w) / 4, y: y + h / 4 },
                  { x: x + (3 * w) / 4, y: y + (3 * h) / 4 },
                  { x: x + w / 4, y: y + (3 * h) / 4 },
                  { x: x + w / 4, y: y + h / 4 },
              ]
            : [
                  { x: x + w / 2, y },
                  { x: x + w, y: y + h / 2 },
                  { x: x + w / 2, y: y + h },
                  { x, y: y + h / 2 },
              ];
    const center = boxCenter(shape);
    return local.map((p) => rotatePoint(p, center, shape.angle));
}

// The side-midpoint snap dots over a bind candidate (B2): all four rendered, the one nearest the pointer
// within bindingDistance + strokeWidth/2 filled in the accent, the rest ghosted. For a NON-elbow arrow the
// dots are suppressed while the cursor is buried inside the shape (Excalidraw's !isPointInElement); for an
// elbow arrow all four always show, even inside.
export function SnapDots({
    shape,
    pointer,
    zoom,
    elbow,
}: {
    shape: VectorShapeElement;
    pointer: Point;
    zoom: number;
    elbow: boolean;
}) {
    // Excalidraw draws nothing when the cursor is buried inside a NON-elbow bindable (interactiveScene's
    // `!cursorIsInsideBindable || isElbow` gate); an elbow always draws.
    if (!elbow && pointInsideShape(shape, pointer)) return null;
    const mids = sideMidpoints(shape);
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

// The focus-point affordance for a selected bound STRAIGHT arrow, per bound end (B4/D5): a solid dock dot on
// the shape outline (the endpoint), a dashed line to the hollow anchor dot inside the shape, so the
// distinction between "the anchor the arrow aims at" and "the endpoint on the outline" is visible and the
// release orbit reads as intended rather than a jump. Never for elbow arrows (their endpoint IS the anchor).
// The end currently being dragged is skipped (`hideEnd`) — Excalidraw hides the focus point of the dragged
// end. An end is drawn only when its anchor sits far enough from its endpoint to be worth showing.
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
    if (arrow.elbow || parsePoints(arrow.points).length !== 2) return null;
    const ends: ('start' | 'end')[] = ['start', 'end'];
    const nodes = ends.map((end) => {
        if (end === hideEnd) return null;
        const binding = parseBinding(end === 'start' ? arrow.startBinding : arrow.endBinding);
        if (!binding) return null;
        const shape = byId.get(binding.elementId);
        if (!shape || (shape.type !== 'rectangle' && shape.type !== 'diamond' && shape.type !== 'ellipse')) return null;
        const anchor = anchorToScene(shape, binding.fixedPoint);
        const endpoint = boundEndpoint(arrow, end, shape);
        // Hide when the anchor has all but collapsed onto the endpoint (isFocusPointVisible's distance gate).
        if (dist(anchor, endpoint) * zoom < FOCUS_MIN_SCREEN_GAP) return null;
        return (
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
        );
    });
    return <>{nodes}</>;
}
