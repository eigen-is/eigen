// Arrow binding lifecycle for the tools layer — the candidate search under a dragged endpoint, the
// commit that stores each end's binding and snaps it to the shape outline, the live preview follow, the
// unbind-on-drag rule, and the paste remap (R3.8–R3.11). All the geometry lives in lib (bindingAnchor,
// boundEndpoint, followBindings, bindingDistance, remapBinding); this module is the thin UI glue the
// canvas and the drawing hook call, so those files only dispatch.

import {
    type Box,
    bindingAnchor,
    bindingDistance,
    followBindings,
    hitTestBox,
    hitTestDiamond,
    hitTestEllipse,
    isBindable,
    isTransparent,
    linearLocalToScene,
    type Point,
    parseBinding,
    parsePoints,
    remapBinding,
    serializeBinding,
    type VectorArrowElement,
    type VectorElement,
    type VectorShapeElement,
} from '@workspace/lib/vector';

// Is `point` within `pad` of the shape's outline in the shape's own frame — the shape's box grown (or,
// with a negative pad, shrunk) uniformly on all sides, hit-tested by type. The centre is unchanged, so a
// rotated shape stays correct (the type hit-tests unrotate about the centre).
function insideShape(shape: VectorShapeElement, point: Point, pad: number): boolean {
    const box: Box = {
        x: shape.x - pad,
        y: shape.y - pad,
        width: shape.width + 2 * pad,
        height: shape.height + 2 * pad,
        angle: shape.angle,
    };
    if (shape.type === 'ellipse') return hitTestEllipse(box, point);
    if (shape.type === 'diamond') return hitTestDiamond(box, point);
    return hitTestBox(box, point);
}

// Whether a dragged endpoint at `point` should bind to a shape: a filled shape binds anywhere inside or
// within the reach band outside; a transparent one binds only in the band AROUND its outline (scout §2).
function reaches(shape: VectorShapeElement, point: Point, distance: number): boolean {
    if (!isTransparent(shape.backgroundColor)) return insideShape(shape, point, distance);
    return insideShape(shape, point, distance) && !insideShape(shape, point, -distance);
}

// The bindable shape a dragged endpoint would bind to: the SMALLEST candidate whose reach band contains
// `point`, within bindingDistance(zoom) scene units; null when suppressed (Ctrl/Cmd) or nothing reaches.
export function bindingCandidate(
    ordered: VectorElement[],
    point: Point,
    zoom: number,
    suppressed: boolean,
): string | null {
    if (suppressed) return null;
    const distance = bindingDistance(zoom);
    let best: VectorShapeElement | null = null;
    for (const el of ordered) {
        if (!isBindable(el) || !reaches(el, point, distance)) continue;
        if (!best || el.width * el.height < best.width * best.height) best = el;
    }
    return best ? best.id : null;
}

// The shape-following highlight over a bindable target (R3.8): the shape re-stroked in the selection
// colour with a clean 2px screen line and no fill, reusing the SAME per-shape geometry the renderer uses
// (rect roundness / diamond / ellipse, rotated), so no shape math is duplicated here. `currentColor`
// lets the caller tint it via a `text-selection-handle` group; strokeWidth ÷ zoom keeps it 2px on screen
// at any zoom (the scene group scales). Rendered through elementToSvg like every other scene node.
export function bindingOutlineElement(shape: VectorShapeElement, zoom: number): VectorShapeElement {
    return {
        ...shape,
        strokeColor: 'currentColor',
        strokeWidth: 2 / zoom,
        strokeStyle: 'solid',
        backgroundColor: 'transparent',
        roughness: 0,
        opacity: 100,
    };
}

function bindingFor(ordered: VectorElement[], scene: Point, zoom: number, suppressed: boolean): string {
    const id = bindingCandidate(ordered, scene, zoom, suppressed);
    if (!id) return '';
    const shape = ordered.find((el) => el.id === id);
    if (!shape || !isBindable(shape)) return '';
    return serializeBinding({ elementId: id, fixedPoint: bindingAnchor(shape, scene) });
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
): { startBinding: string; endBinding: string; x: number; y: number; width: number; height: number; points: string } {
    const points = parsePoints(arrow.points);
    const startScene = linearLocalToScene(arrow, points[0]);
    const endScene = linearLocalToScene(arrow, points[points.length - 1]);
    const startBinding = evaluate.start ? bindingFor(ordered, startScene, zoom, suppressed) : arrow.startBinding;
    const endBinding = evaluate.end ? bindingFor(ordered, endScene, zoom, suppressed) : arrow.endBinding;
    const bound = { ...arrow, startBinding, endBinding };
    const byId = new Map(ordered.map((el) => [el.id, el]));
    const geom = followBindings(bound, byId) ?? {
        x: arrow.x,
        y: arrow.y,
        width: arrow.width,
        height: arrow.height,
        points: arrow.points,
    };
    return { startBinding, endBinding, ...geom };
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
// rode along rigidly (R3.10).
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
// pasted → its clone's id, a target outside the paste → cleared (R3.11). `cloneIds` maps each partial's
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
