// Arrow binding lifecycle for the tools layer — the candidate search under a dragged endpoint, the
// commit that stores each end's binding and snaps it to the shape outline, the live preview follow, the
// unbind-on-drag rule, and the paste remap. All the geometry lives in lib (bindingAnchor,
// boundEndpoint, followBindings, bindingDistance, remapBinding); this module is the thin UI glue the
// canvas and the drawing hook call, so those files only dispatch.

import {
    anchorToScene,
    type Box,
    bindingAnchor,
    bindingDistance,
    boxCenter,
    ELEMENT_KINDS,
    elbowAnchorScene,
    elbowRoutingContext,
    followBindings,
    isBindable,
    isTransparentFill,
    linearLocalToScene,
    moveEndpoints,
    outlineContains,
    outlinePath,
    type PinPatch,
    type Point,
    parseBinding,
    parseFill,
    parsePoints,
    projectFixedPointOntoDiagonal,
    remapBinding,
    rotatePoint,
    serializeBinding,
    type VectorArrowElement,
    type VectorBindableElement,
    type VectorElement,
} from '@workspace/lib/vector';

// Is `point` inside the shape's own outline grown by `pad` (shrunk, for a negative pad)? The kind owns
// the curve, so a rounded corner binds where it is drawn rather than out at the sharp box. The outline
// lives in the shape's unrotated frame, so the query point is unrotated about the centre to match.
function insideShape(shape: VectorBindableElement, point: Point, pad: number): boolean {
    const local = rotatePoint(point, boxCenter(shape), -shape.angle);
    return outlineContains(ELEMENT_KINDS[shape.type].outline(shape, pad), local);
}

// Whether a dragged endpoint at `point` should bind to a shape: one with a body binds anywhere inside or
// within the reach band outside; a see-through one binds only in the band AROUND its outline.
function reaches(shape: VectorBindableElement, point: Point, distance: number): boolean {
    if (!isSeeThrough(shape)) return insideShape(shape, point, distance);
    return insideShape(shape, point, distance) && !insideShape(shape, point, -distance);
}

// Can the endpoint be dropped THROUGH this shape's middle? Its Fill answers for every kind that paints
// one; an image's body is its pixels, so it has no `fill` field and never reads as see-through.
function isSeeThrough(shape: VectorBindableElement): boolean {
    return 'fill' in shape && isTransparentFill(parseFill(shape.fill));
}

// The bindable shape a dragged endpoint would bind to: the SMALLEST candidate whose reach band contains
// `point`, within bindingDistance(zoom) scene units; null when suppressed (Ctrl/Cmd) or nothing reaches.
export function bindingCandidate(
    ordered: VectorElement[],
    point: Point,
    zoom: number,
    suppressed: boolean,
): VectorBindableElement | null {
    if (suppressed) return null;
    const distance = bindingDistance(zoom);
    let best: VectorBindableElement | null = null;
    for (const el of ordered) {
        if (!isBindable(el) || !reaches(el, point, distance)) continue;
        if (!best || el.width * el.height < best.width * best.height) best = el;
    }
    return best;
}

// The shape-following highlight over a bindable target: the kind's OWN outline — the one the dock is
// resolved against — stroked in the selection colour, rotated about the shape's centre the way every
// caller of `outline()` rotates. Drawn from the outline rather than by re-rendering the element, so a
// rich text box or an image is traced without its words or its pixels being painted a second time.
// `currentColor` lets the caller tint it via a `text-selection-handle` group; the width ÷ zoom keeps it
// 2px on screen at any zoom (the scene group scales).
export function bindingOutlineSvg(shape: VectorBindableElement, zoom: number): string {
    const d = outlinePath(ELEMENT_KINDS[shape.type].outline(shape, 0));
    const c = boxCenter(shape);
    const rotate = shape.angle === 0 ? '' : ` transform="rotate(${shape.angle} ${c.x} ${c.y})"`;
    return `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${2 / zoom}"${rotate}/>`;
}

// The aim the OTHER end holds while `end` binds — the point projectFixedPointOntoDiagonal casts its ray
// from (Excalidraw's `a`): the opposite end's anchor when it is bound (stable through this end's drag),
// else the opposite endpoint's raw scene position.
function otherEndAim(
    arrow: VectorArrowElement,
    end: 'start' | 'end',
    points: Point[],
    ordered: VectorElement[],
): Point {
    // A multi-point straight arrow aims from the ADJACENT vertex — the segment that actually leaves this
    // end — not the far endpoint (Excalidraw's utils.ts:707-733). Only a 2-pointer falls back to the
    // opposite end (its bound anchor when set, else the far endpoint).
    if (points.length > 2) {
        return linearLocalToScene(arrow, end === 'start' ? points[1] : points[points.length - 2]);
    }
    const otherLocal = end === 'start' ? points[points.length - 1] : points[0];
    const parsed = parseBinding(end === 'start' ? arrow.endBinding : arrow.startBinding);
    if (parsed) {
        const otherShape = ordered.find((el) => el.id === parsed.elementId);
        if (otherShape && isBindable(otherShape)) return anchorToScene(otherShape, parsed.fixedPoint);
    }
    return linearLocalToScene(arrow, otherLocal);
}

function bindingFor(
    arrow: VectorArrowElement,
    ordered: VectorElement[],
    scene: Point,
    otherEnd: Point,
    zoom: number,
    suppressed: boolean,
): string {
    const shape = bindingCandidate(ordered, scene, zoom, suppressed);
    if (!shape) return '';
    // Straight arrows aim the stored ratio through a natural line — project the raw endpoint onto the shape's
    // diagonals / centre lines (or snap to a side midpoint), Excalidraw's bind-time nicety that makes fresh
    // arrows point through the middle rather than at wherever the cursor landed. But that projection is the
    // "orbit" strategy — it applies ONLY when the endpoint lands OUTSIDE the shape's fill. A drop INSIDE the
    // fill is the "inside" strategy and stores the RAW cursor ratio verbatim (Excalidraw's getBindingStrategy*
    // → calculateFixedPointForNonElbowArrowBinding, gated on isPointInElement). Re-projecting an inside drop
    // would fling the anchor off the release point onto the diagonal, toward the centre.
    // Elbow arrows keep the raw anchor too (their outline dock is resolved separately, never a diagonal).
    const focus =
        arrow.elbow || pointInsideShape(shape, scene)
            ? scene
            : (projectFixedPointOntoDiagonal(shape, scene, otherEnd, arrow, zoom) ?? scene);
    return serializeBinding({ elementId: shape.id, fixedPoint: bindingAnchor(shape, focus) });
}

// Resolve an arrow's bindings on commit (creation or an endpoint-handle drag). For each end flagged in
// `evaluate`, search for a candidate under that endpoint and bind (or clear when none/suppressed); an end
// left out keeps the arrow's current binding. Then snap every bound endpoint to its shape through
// followBindings — the same path a later shape move uses — so the write already sits on the outline.
export function bindArrow(
    arrow: VectorArrowElement,
    evaluate: { start: boolean; end: boolean },
    ordered: VectorElement[],
    zoom: number,
    suppressed: boolean,
): {
    startBinding: string;
    endBinding: string;
    x: number;
    y: number;
    width: number;
    height: number;
    points: string;
    fixedSegments: string;
} {
    const points = parsePoints(arrow.points);
    const startScene = linearLocalToScene(arrow, points[0]);
    const endScene = linearLocalToScene(arrow, points[points.length - 1]);
    const startBinding = evaluate.start
        ? bindingFor(arrow, ordered, startScene, otherEndAim(arrow, 'start', points, ordered), zoom, suppressed)
        : arrow.startBinding;
    const endBinding = evaluate.end
        ? bindingFor(arrow, ordered, endScene, otherEndAim(arrow, 'end', points, ordered), zoom, suppressed)
        : arrow.endBinding;
    const bound = { ...arrow, startBinding, endBinding };
    const byId = new Map(ordered.map((el) => [el.id, el]));
    return { startBinding, endBinding, ...followedGeom(bound, byId) };
}

type BoundGeom = {
    startBinding: string;
    endBinding: string;
    x: number;
    y: number;
    width: number;
    height: number;
    points: string;
    fixedSegments: string;
};

function followedGeom(
    arrow: VectorArrowElement,
    byId: Map<string, VectorElement>,
): Omit<BoundGeom, 'startBinding' | 'endBinding'> {
    return (
        followBindings(arrow, byId) ?? {
            x: arrow.x,
            y: arrow.y,
            width: arrow.width,
            height: arrow.height,
            points: arrow.points,
            fixedSegments: arrow.fixedSegments,
        }
    );
}

// Bind (or unbind, when `fixedPoint` is null) a dragged/creating ELBOW endpoint from a PRE-COMPUTED dock
// ratio — elbowBindPoint's fixedPoint for the hovered candidate — never re-derived from the release cursor.
// The end's binding is set from that ratio, then followBindings re-glues every bound end onto its
// shape: for an elbow end that is elbowAnchorScene(fixedPoint) = the dock, so the stored endpoint lands
// exactly where the preview showed, and the OTHER bound end re-docks too. The preview and the commit call
// this identically, so pointer-up is a visual no-op. An unbound
// end keeps its raw dragged point (followBindings never touches a cleared end).
export function bindElbowEnd(
    arrow: VectorArrowElement,
    end: 'start' | 'end',
    candidate: string | null,
    fixedPoint: [number, number] | null,
    byId: Map<string, VectorElement>,
): BoundGeom {
    const binding = candidate && fixedPoint ? serializeBinding({ elementId: candidate, fixedPoint }) : '';
    const startBinding = end === 'start' ? binding : arrow.startBinding;
    const endBinding = end === 'end' ? binding : arrow.endBinding;
    return { startBinding, endBinding, ...followedGeom({ ...arrow, startBinding, endBinding }, byId) };
}

// The PINNED analog of bindElbowEnd: bind (or unbind) a dragged pinned-elbow endpoint from a
// pre-computed dock ratio, but keep the interior polyline + every pin VERBATIM (moveEndpoints) rather than
// re-deriving the whole route. When bound, the endpoint docks where followBindings will later rest it
// (elbowAnchorScene(fixedPoint)), so release === the shape's next move — no raw-cursor detach; an unbound
// end keeps its raw dragged point. Run renormalize on the result for the sealed commit (unless derived).
export function bindPinnedElbowEnd(
    arrow: VectorArrowElement,
    end: 'start' | 'end',
    candidate: string | null,
    fixedPoint: [number, number] | null,
    rawScene: Point,
    byId: Map<string, VectorElement>,
): PinPatch & { startBinding: string; endBinding: string } {
    const binding = candidate && fixedPoint ? serializeBinding({ elementId: candidate, fixedPoint }) : '';
    const startBinding = end === 'start' ? binding : arrow.startBinding;
    const endBinding = end === 'end' ? binding : arrow.endBinding;
    const shape = candidate ? byId.get(candidate) : undefined;
    const dock = shape && isBindable(shape) && fixedPoint ? elbowAnchorScene(shape, fixedPoint) : rawScene;
    // The jog context reflects the endpoint's NEW binding (bound/unbound after this drag).
    const ctx = elbowRoutingContext({ ...arrow, startBinding, endBinding }, byId);
    const moved = moveEndpoints(arrow, end === 'start' ? dock : null, end === 'end' ? dock : null, ctx);
    return { ...moved, startBinding, endBinding };
}

// Re-aim a straight arrow's already-bound end to a NEW fixedPoint dragged on its focus dot. The bound
// SHAPE is unchanged — only the aim ratio moves — so there is no candidate search and no diagonal projection
// (Excalidraw's handleFocusPointDrag stores the raw dragged ratio; the projection is a bind-time-only
// nicety, and re-projecting here would fight the drag). followBindings re-derives the chord endpoint from the
// new anchor, exactly as the preview showed, so pointer-up is a visual no-op. `fixedPoint` is the caller's
// already-clamped ([0,1]) aim, so the anchor stays inside the shape.
export function bindFocusPoint(
    arrow: VectorArrowElement,
    end: 'start' | 'end',
    elementId: string,
    fixedPoint: [number, number],
    byId: Map<string, VectorElement>,
): BoundGeom {
    const binding = serializeBinding({ elementId, fixedPoint });
    const startBinding = end === 'start' ? binding : arrow.startBinding;
    const endBinding = end === 'end' ? binding : arrow.endBinding;
    return { startBinding, endBinding, ...followedGeom({ ...arrow, startBinding, endBinding }, byId) };
}

// Live-follow the OTHER bound end while a straight arrow's endpoint is dragged: re-glue only the end
// that isn't `dragged` so it re-orbits toward the moving cursor exactly as release will, while the dragged
// end keeps its raw cursor position (its binding is cleared for the follow, so followBindings leaves it
// alone). Returns the element unchanged when the other end isn't bound / nothing moved.
export function followOtherEnd(
    arrow: VectorArrowElement,
    dragged: 'start' | 'end',
    byId: Map<string, VectorElement>,
): { x: number; y: number; width: number; height: number; points: string } {
    const cleared = dragged === 'start' ? { startBinding: '' } : { endBinding: '' };
    return followedGeom({ ...arrow, ...cleared }, byId);
}

// Whether a scene point sits within a shape's exact outline (no reach band) — the deep-inside test used
// to suppress the side-midpoint snap dots for a NON-elbow arrow (Excalidraw shows them only around the
// outline, not when the cursor is buried inside the shape).
export function pointInsideShape(shape: VectorBindableElement, point: Point): boolean {
    return insideShape(shape, point, 0);
}

// The map every follow reads, with each previewed element carrying its live preview box, so a bound arrow
// tracks a shape that is mid-drag/resize. Only the shape entries matter (arrows aren't bindable).
export function buildPreviewById(ordered: VectorElement[], previews: Record<string, Box>): Map<string, VectorElement> {
    const map = new Map<string, VectorElement>();
    for (const el of ordered) {
        const p = previews[el.id];
        map.set(el.id, p ? { ...el, x: p.x, y: p.y, width: p.width, height: p.height, angle: p.angle } : el);
    }
    return map;
}

// Live follow for an arrow whose bound shape is currently previewed (moved/resized/rotated but not the
// arrow itself). null when no bound shape is previewed or nothing changed — the arrow renders as stored.
export function followArrowPreview(
    arrow: VectorArrowElement,
    previews: Record<string, Box>,
    byId: Map<string, VectorElement>,
): { x: number; y: number; width: number; height: number; points: string } | null {
    let previewed = false;
    for (const b of [arrow.startBinding, arrow.endBinding]) {
        const parsed = parseBinding(b);
        if (parsed && previews[parsed.elementId]) {
            previewed = true;
            break;
        }
    }
    return previewed ? followBindings(arrow, byId) : null;
}

// The binding fields to clear when a bound arrow is dragged: an end whose shape is NOT part of the same
// drag unbinds (the endpoint moved off it); a shape dragged together with the arrow keeps its binding and
// rode along rigidly.
export function unbindDraggedArrow(
    arrow: VectorArrowElement,
    movedIds: Set<string>,
): { startBinding?: string; endBinding?: string } {
    const fields: { startBinding?: string; endBinding?: string } = {};
    if (boundOutside(arrow.startBinding, movedIds)) fields.startBinding = '';
    if (boundOutside(arrow.endBinding, movedIds)) fields.endBinding = '';
    return fields;
}

function boundOutside(binding: string, movedIds: Set<string>): boolean {
    const parsed = parseBinding(binding);
    return parsed !== null && !movedIds.has(parsed.elementId);
}

// Bindings a paste carries, waiting to be remapped once its clones have ids.
export type PastedArrow = { index: number; startBinding: string; endBinding: string };

// Remap each pasted arrow's bindings across the pasted set (ids in partial order): a target shape that was
// pasted → its clone's id, a target outside the paste → cleared. `cloneIds` maps each partial's
// index to its source element id.
export function remapPastedArrows(
    arrows: PastedArrow[],
    cloneIds: Map<number, string>,
    ids: string[],
): { id: string; fields: { startBinding: string; endBinding: string } }[] {
    const idMap = new Map<string, string>();
    for (const [index, oldId] of cloneIds) {
        const newId = ids[index];
        if (newId) idMap.set(oldId, newId);
    }
    const patches: { id: string; fields: { startBinding: string; endBinding: string } }[] = [];
    for (const arrow of arrows) {
        const id = ids[arrow.index];
        if (!id) continue;
        patches.push({
            id,
            fields: {
                startBinding: remapBinding(arrow.startBinding, idMap),
                endBinding: remapBinding(arrow.endBinding, idMap),
            },
        });
    }
    return patches;
}
