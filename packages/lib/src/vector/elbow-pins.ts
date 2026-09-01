// Incremental editors for a PINNED elbow arrow (Excalidraw's fixedSegments model, ports of
// packages/element/src/elbowArrow.ts + linearElementEditor.ts). Once an elbow arrow has ≥1 pin its
// `points` hold the full routed polyline and the A* router never runs on it again (see arrowRoute's
// two-mode fork). Every mutation is pure point surgery on that stored polyline: a segment move slides the
// dragged segment and stretches its neighbours in place (zero new interior corners); renormalization on
// commit merges collinear runs, drops sub-pixel debris and reindexes pins; unpin re-routes only the freed
// gap. All functions are pure over the parsed arrow — the UI/geometry seams call them and write the patch.
//
// Everything works in the arrow's LOCAL frame; elbow arrows pin angle 0, so scene = local + (x,y). Pins
// key by `index` into `points` (points[index-1]→points[index]); start/end are rebuilt from the polyline on
// every normalize, so the stored copies never drift.

import { type Point, parsePoints, serializePoints } from './geometry';
import { type FixedSegment, parseFixedSegments, serializeFixedSegments, type VectorArrowElement } from './types';

// The geometry patch every editor returns — the fields a pinned-arrow write persists together.
export type PinPatch = {
    points: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fixedSegments: string;
};

// The routing context an end-segment jog needs, resolved at the call seam (elbow-route's
// elbowRoutingContext) so elbow-pins stays pure. Excalidraw's handleSegmentMove/handleEndpointDrag read
// `startHeading`/`endHeading` (the heading each endpoint leaves its shape by) plus `hoveredStartElement`/
// `hoveredEndElement` (is that end bound). Each Heading is decomposed here into horizontal? + positive?
// (RIGHT when horizontal, DOWN when vertical) — all the jog/pad math consumes.
export type PinRoutingContext = {
    startBound: boolean;
    endBound: boolean;
    startHeadingHorizontal: boolean;
    startHeadingPositive: boolean;
    endHeadingHorizontal: boolean;
    endHeadingPositive: boolean;
};

// An all-unbound context (each heading points at the other endpoint): the default when no bound context is
// threaded — an interior-segment drag never reads it, so only end-segment drags of unbound arrows care.
export const UNBOUND_PIN_CONTEXT: PinRoutingContext = {
    startBound: false,
    endBound: false,
    startHeadingHorizontal: false,
    startHeadingPositive: false,
    endHeadingHorizontal: false,
    endHeadingPositive: false,
};

const DEDUP_THRESHOLD = 1;
// Excalidraw's BASE_PADDING (elbowArrow.ts:111) — the room an inserted end connector leaves the shape by.
const BASE_PADDING = 40;

// A parsed pinned arrow: its polyline in GLOBAL scene coordinates plus the pins (global start/end) and the
// synthetic-point markers. The editors work in global then re-origin through normalizeElbowUpdate.
type Working = {
    points: Point[];
    segments: WorkingSegment[];
    startIsSpecial: boolean;
    endIsSpecial: boolean;
};
type WorkingSegment = { index: number; start: Point; end: Point };

// --- small vector helpers (Excalidraw's @excalidraw/math, inlined) ---------------------

function headingIsHorizontalVec(a: Point, b: Point): boolean {
    // The dominant axis of a→b — Excalidraw's headingForPointIsHorizontal (|dy| < |dx|).
    return Math.abs(a.y - b.y) < Math.abs(a.x - b.x);
}

function pointsEqual(a: Point, b: Point): boolean {
    return a.x === b.x && a.y === b.y;
}

// Excalidraw's validateElbowPoints: consecutive points differ on at most one axis within tolerance (an
// orthogonal polyline). The gate that keeps a corrupt/foreign polyline from being trusted as pinned.
export function validateElbowPoints(points: Point[], tolerance = DEDUP_THRESHOLD): boolean {
    for (let i = 1; i < points.length; i++) {
        const p = points[i];
        const q = points[i - 1];
        if (!(Math.abs(p.x - q.x) < tolerance || Math.abs(p.y - q.y) < tolerance)) return false;
    }
    return true;
}

// --- parse / normalize -----------------------------------------------------------------

// Decode an arrow into the global working form (points + pins in scene coordinates).
function toWorking(arrow: VectorArrowElement): Working {
    const local = parsePoints(arrow.points);
    const points = local.map((p) => ({ x: arrow.x + p.x, y: arrow.y + p.y }));
    const parsed = parseFixedSegments(arrow.fixedSegments);
    const segments = parsed.segments.map((s) => ({
        index: s.index,
        start: { x: arrow.x + s.start[0], y: arrow.y + s.start[1] },
        end: { x: arrow.x + s.end[0], y: arrow.y + s.end[1] },
    }));
    return { points, segments, startIsSpecial: parsed.startIsSpecial, endIsSpecial: parsed.endIsSpecial };
}

// Excalidraw's normalizeArrowElementUpdate: re-origin the global polyline so points[0] is local (0,0),
// rebuild every pin's start/end from the normalized polyline at its index (so the copies match the
// vertices), and serialize. `null`-equivalent (no pins) ⇒ '' so the arrow returns to derived mode.
function normalizeElbowUpdate(
    global: Point[],
    segments: { index: number }[],
    startIsSpecial: boolean,
    endIsSpecial: boolean,
): PinPatch {
    const offsetX = global[0].x;
    const offsetY = global[0].y;
    const local = global.map((p) => ({ x: p.x - offsetX, y: p.y - offsetY }));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of local) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    // Rebuild pin coords from the polyline at each index (the discipline that keeps start/end honest).
    const rebuilt: FixedSegment[] = segments
        .filter((s) => s.index >= 1 && s.index < local.length)
        .map((s) => ({
            index: s.index,
            start: [local[s.index - 1].x, local[s.index - 1].y] as [number, number],
            end: [local[s.index].x, local[s.index].y] as [number, number],
        }));
    return {
        points: serializePoints(local),
        x: offsetX,
        y: offsetY,
        width: maxX - minX,
        height: maxY - minY,
        fixedSegments: serializeFixedSegments({
            segments: rebuilt,
            startIsSpecial,
            endIsSpecial,
        }),
    };
}

// --- segment move (moveFixedSegment + handleSegmentMove) ----------------------------

// Excalidraw's moveFixedSegment: upsert the pin at `index`, axis-locked — a horizontal segment keeps its
// endpoints' x from the current polyline and takes the cursor's y, a vertical one mirrored. Returns the
// full sorted pin list (LOCAL coords), the input to handleSegmentMove.
function moveFixedSegment(arrow: VectorArrowElement, index: number, cursorScene: Point): FixedSegment[] {
    const local = parsePoints(arrow.points);
    const parsed = parseFixedSegments(arrow.fixedSegments);
    if (index < 1 || index >= local.length) return parsed.segments;
    const isHorizontal = headingIsHorizontalVec(local[index - 1], local[index]);
    const cx = cursorScene.x - arrow.x;
    const cy = cursorScene.y - arrow.y;
    const upserted: FixedSegment = {
        index,
        start: [isHorizontal ? local[index - 1].x : cx, isHorizontal ? cy : local[index - 1].y],
        end: [isHorizontal ? local[index].x : cx, isHorizontal ? cy : local[index].y],
    };
    const byIndex = new Map<number, FixedSegment>();
    for (const s of parsed.segments) byIndex.set(s.index, s);
    byIndex.set(index, upserted);
    return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

// Excalidraw's handleSegmentMove: overwrite the dragged pin's two vertices, stretch each neighbour's far
// endpoint along the neighbour's own axis (so no new corner appears on an interior drag), and weld any
// adjacent pinned segment to the moved vertex. When the dragged segment is the FIRST or LAST one it inserts
// an L-jog so the pinned segment becomes interior and the endpoint is preserved (unshift/push, +1/+2
// reindex, plus a BASE_PADDING outer-vertex prelude when that end is bound) — the arrow's stored invariant
// that first/last segments are never fixed holds as an output property. `movedIndex` is the pin the caller
// just dragged; `ctx` carries the endpoint headings + bound flags the jog needs.
function handleSegmentMove(
    arrow: VectorArrowElement,
    segments: FixedSegment[],
    movedIndex: number,
    ctx: PinRoutingContext,
): PinPatch {
    const newPoints: Point[] = parsePoints(arrow.points).map((p) => ({ x: arrow.x + p.x, y: arrow.y + p.y }));
    const nextSegments: WorkingSegment[] = segments.map((s) => ({
        index: s.index,
        start: { x: arrow.x + s.start[0], y: arrow.y + s.start[1] },
        end: { x: arrow.x + s.end[0], y: arrow.y + s.end[1] },
    }));
    const moved = nextSegments.find((s) => s.index === movedIndex);
    if (!moved) return normalizeElbowUpdate(newPoints, nextSegments, false, false);

    // The ORIGINAL endpoints + last index, captured before any overwrite/jog — the jog re-inserts these
    // endpoints verbatim (bound) and gates on the pristine point count.
    const lastIndex = newPoints.length - 1;
    const oldStart = { ...newPoints[0] };
    const oldEnd = { ...newPoints[lastIndex] };
    const oldPins = parseFixedSegments(arrow.fixedSegments).segments;
    const hasFirstPin = oldPins.some((s) => s.index === 1);
    const hasLastPin = oldPins.some((s) => s.index === lastIndex);

    // BASE_PADDING prelude (elbowArrow.ts:497-558): before the surgery, push the pin's OUTER vertex away
    // from a bound shape along its heading so the inserted connector has room to leave orthogonally. A short
    // segment pads by half its length instead of the full 40.
    const segmentLength = Math.hypot(moved.end.x - moved.start.x, moved.end.y - moved.start.y);
    const segmentIsTooShort = segmentLength < BASE_PADDING + 5;
    const pad = (positive: boolean): number =>
        positive
            ? segmentIsTooShort
                ? segmentLength / 2
                : BASE_PADDING
            : segmentIsTooShort
              ? -segmentLength / 2
              : -BASE_PADDING;
    if (!hasFirstPin && moved.index === 1 && ctx.startBound) {
        const p = pad(ctx.startHeadingPositive);
        moved.start = {
            x: moved.start.x + (ctx.startHeadingHorizontal ? p : 0),
            y: moved.start.y + (!ctx.startHeadingHorizontal ? p : 0),
        };
    }
    if (!hasLastPin && moved.index === lastIndex && ctx.endBound) {
        const p = pad(ctx.endHeadingPositive);
        moved.end = {
            x: moved.end.x + (ctx.endHeadingHorizontal ? p : 0),
            y: moved.end.y + (!ctx.endHeadingHorizontal ? p : 0),
        };
    }

    const startIdx = moved.index - 1;
    const endIdx = moved.index;
    const start = moved.start;
    const end = moved.end;

    const prevSegmentIsHorizontal =
        newPoints[startIdx - 1] && !pointsEqual(newPoints[startIdx], newPoints[startIdx - 1])
            ? headingIsHorizontalVec(newPoints[startIdx - 1], newPoints[startIdx])
            : undefined;
    const nextSegmentIsHorizontal =
        newPoints[endIdx + 1] && !pointsEqual(newPoints[endIdx], newPoints[endIdx + 1])
            ? headingIsHorizontalVec(newPoints[endIdx + 1], newPoints[endIdx])
            : undefined;

    // Slide the neighbour's far endpoint along the neighbour's own axis (dominant axis ⇒ move the OTHER
    // coordinate: horizontal neighbour keeps y, so take start.y; vertical keeps x, so take start.x).
    if (prevSegmentIsHorizontal !== undefined) {
        if (prevSegmentIsHorizontal) newPoints[startIdx - 1].y = start.y;
        else newPoints[startIdx - 1].x = start.x;
    }
    newPoints[startIdx] = start;
    newPoints[endIdx] = end;
    if (nextSegmentIsHorizontal !== undefined) {
        if (nextSegmentIsHorizontal) newPoints[endIdx + 1].y = end.y;
        else newPoints[endIdx + 1].x = end.x;
    }

    // Weld a neighbouring pinned segment to the moved vertex so adjacent pins stay welded (no notch).
    const prevPinned = nextSegments.find((s) => s.index === startIdx);
    if (prevPinned) {
        if (headingIsHorizontalVec(prevPinned.start, prevPinned.end)) prevPinned.start.y = start.y;
        else prevPinned.start.x = start.x;
        prevPinned.end = { ...start };
    }
    const nextPinned = nextSegments.find((s) => s.index === endIdx + 1);
    if (nextPinned) {
        if (headingIsHorizontalVec(nextPinned.start, nextPinned.end)) nextPinned.end.y = end.y;
        else nextPinned.end.x = end.x;
        nextPinned.start = { ...end };
    }

    // First-segment jog (elbowArrow.ts:686-707): unshift an L-corner so the pinned segment turns interior;
    // when the start is bound, also unshift the old endpoint back (preserved verbatim) and reindex every pin
    // by +2, else +1. The corner shares the pin's outer coordinate on the heading axis and the endpoint's on
    // the other (unbound uses the point-derived heading, bound the shape heading).
    if (!hasFirstPin && startIdx === 0) {
        const startIsHorizontal = ctx.startBound
            ? ctx.startHeadingHorizontal
            : headingIsHorizontalVec(newPoints[1], newPoints[0]);
        newPoints.unshift({
            x: startIsHorizontal ? start.x : oldStart.x,
            y: !startIsHorizontal ? start.y : oldStart.y,
        });
        if (ctx.startBound) newPoints.unshift({ ...oldStart });
        const shift = ctx.startBound ? 2 : 1;
        for (const s of nextSegments) s.index += shift;
    }

    // Last-segment jog (elbowArrow.ts:709-733): symmetric push at the tail — no reindex, since appending
    // doesn't shift existing indices. The tail jog always reads the (real, unbound-included) end heading.
    if (!hasLastPin && endIdx === lastIndex) {
        const endIsHorizontal = ctx.endHeadingHorizontal;
        newPoints.push({
            x: endIsHorizontal ? end.x : oldEnd.x,
            y: !endIsHorizontal ? end.y : oldEnd.y,
        });
        if (ctx.endBound) newPoints.push({ ...oldEnd });
    }

    return normalizeElbowUpdate(newPoints, nextSegments, false, false);
}

// One gesture step: move the pin at `index` to the cursor and rebuild the polyline. The UI calls this
// per pointermove on an already-pinned arrow; the patch it returns is what release commits (after
// renormalization). `ctx` carries the routing context an end-segment jog needs (unbound default otherwise).
export function moveSegment(
    arrow: VectorArrowElement,
    index: number,
    cursorScene: Point,
    ctx: PinRoutingContext = UNBOUND_PIN_CONTEXT,
): PinPatch {
    const segments = moveFixedSegment(arrow, index, cursorScene);
    return handleSegmentMove(arrow, segments, index, ctx);
}

// --- first pin materializes the polyline --------------------------------------------

// Freeze a derived route into `points` and pin the dragged segment in ONE step. `route` is the
// arrow's current derived polyline (elbowRoute output, LOCAL). Returns the patch that flips the arrow into
// stored-polyline mode with its first pin.
export function materializeFirstPin(
    arrow: VectorArrowElement,
    route: Point[],
    index: number,
    cursorScene: Point,
    ctx: PinRoutingContext = UNBOUND_PIN_CONTEXT,
): PinPatch {
    // The frozen arrow: points now the full route, still no pins — the base moveSegment mutates.
    const frozen: VectorArrowElement = { ...arrow, points: serializePoints(route), fixedSegments: '' };
    return moveSegment(frozen, index, cursorScene, ctx);
}

// --- renormalization on commit ------------------------------------------------------

// Excalidraw's handleSegmentRenormalization: merge collinear neighbour segments (pin reindex −1), drop
// sub-pixel segments (reindex −2), and drop any pin that ends up first/last. Run as the LAST step of every
// sealed write of a pinned arrow. If no pin survives ⇒ '' (the caller returns to derived mode).
export function renormalize(arrow: VectorArrowElement): PinPatch {
    const w = toWorking(arrow);
    const points = w.points.map((p) => ({ ...p }));
    const segments = w.segments.map((s) => ({ index: s.index, start: { ...s.start }, end: { ...s.end } }));

    // Pass 1: drop a point whose two adjacent segments are collinear (same heading), merging pins.
    for (let i = points.length - 2; i >= 1; i--) {
        const currentHorizontal = headingIsHorizontalVec(points[i], points[i + 1]);
        const prevHorizontal = headingIsHorizontalVec(points[i - 1], points[i]);
        if (currentHorizontal !== prevHorizontal) continue;
        // A pin exactly on this segment survives (its coord updates); a pin on the merged-away one is
        // dropped; higher pins reindex −1.
        const here = segments.findIndex((s) => s.index === i + 1);
        const prevIdx = segments.findIndex((s) => s.index === i);
        if (here !== -1) segments[here].start = { ...points[i - 1] };
        if (prevIdx !== -1) segments.splice(prevIdx, 1);
        points.splice(i, 1);
        for (const s of segments) if (s.index > i) s.index -= 1;
    }

    // Pass 2: drop interior segments shorter than the dedup threshold. Fidelity delta vs Excalidraw:
    // upstream removes the short segment's TWO points in one step (pin reindex −2) and re-aligns the merged
    // vertex; we drop one point per iteration (reindex −1). The loop converges on the same polyline, not the
    // same intermediate step — acceptable because renormalize only runs as the sealed commit, never mid-frame.
    for (let i = points.length - 2; i >= 1; i--) {
        if (Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) >= DEDUP_THRESHOLD) continue;
        const onIt = segments.findIndex((s) => s.index === i);
        if (onIt !== -1) segments.splice(onIt, 1);
        points.splice(i, 1);
        for (const s of segments) if (s.index > i) s.index -= 1;
    }

    // Drop pins that landed on the first or last segment (unfixable).
    const kept = segments.filter((s) => s.index !== 1 && s.index !== points.length - 1);
    return normalizeElbowUpdate(points, kept, kept.length > 0 && w.startIsSpecial, kept.length > 0 && w.endIsSpecial);
}

// --- endpoint / bound-shape moves (handleEndpointDrag, else-branch) ------------------

// The 2-point DERIVED patch — used when the last pin dissolves and the arrow returns to derived mode
// (bbox-min origin, matching normalizeLinear at angle 0). fixedSegments back to ''.
function derivedPatch(start: Point, end: Point): PinPatch {
    const minX = Math.min(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    return {
        points: serializePoints([
            { x: start.x - minX, y: start.y - minY },
            { x: end.x - minX, y: end.y - minY },
        ]),
        x: minX,
        y: minY,
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
        fixedSegments: '',
    };
}

// Move a pinned arrow's endpoint(s) (Excalidraw's handleEndpointDrag): the interior points — and every pin
// — are kept VERBATIM; only the start pair and end pair are rebuilt so the connector re-drops orthogonally
// onto the new endpoint. `null` keeps that endpoint at its current position. When the new bind heading is
// PARALLEL to the second segment the connector needs an extra L-jog: two synthetic points are inserted and
// startIsSpecial/endIsSpecial set so a later move knows to remove them again — repeated bound-shape moves
// rebuild the front/tail fresh, so corners never accrete. Returns a full patch (run renormalize after).
export function moveEndpoints(
    arrow: VectorArrowElement,
    newStart: Point | null,
    newEnd: Point | null,
    ctx: PinRoutingContext = UNBOUND_PIN_CONTEXT,
): PinPatch {
    const w = toWorking(arrow);
    const points = w.points;
    const n = points.length;
    if (n < 4) return normalizeElbowUpdate(points, w.segments, w.startIsSpecial, w.endIsSpecial);

    let startIsSpecial = w.startIsSpecial;
    let endIsSpecial = w.endIsSpecial;
    const startGlobal = newStart ?? points[0];
    const endGlobal = newEnd ?? points[n - 1];
    // The polyline with only the two endpoints replaced — the source both connector rebuilds read from.
    const src: Point[] = points.map((p, i) => (i === 0 ? startGlobal : i === n - 1 ? endGlobal : p));
    const segments = w.segments.map((s) => ({ index: s.index }));

    // Copy the interior window verbatim (skipping the start/end connectors, whose count depends on the
    // current isSpecial flags), then rebuild the start front and end tail.
    const offset = 2 + (startIsSpecial ? 1 : 0);
    const endOffset = 2 + (endIsSpecial ? 1 : 0);
    const newPoints: Point[] = [];
    while (newPoints.length + offset < src.length - endOffset) newPoints.push({ ...src[newPoints.length + offset] });

    // Start front (elbowArrow.ts:750-812): project the second point onto the new start's axis, or — when
    // bound and the heading is parallel to the second segment — insert the two-point BASE_PADDING jog.
    {
        const second = src[startIsSpecial ? 2 : 1];
        const third = src[startIsSpecial ? 3 : 2];
        const secondIsHorizontal = headingIsHorizontalVec(second, third);
        if (ctx.startBound && ctx.startHeadingHorizontal === secondIsHorizontal) {
            const p = ctx.startHeadingPositive ? BASE_PADDING : -BASE_PADDING;
            newPoints.unshift({
                x: !secondIsHorizontal ? third.x : startGlobal.x + p,
                y: secondIsHorizontal ? third.y : startGlobal.y + p,
            });
            newPoints.unshift({
                x: ctx.startHeadingHorizontal ? startGlobal.x + p : startGlobal.x,
                y: !ctx.startHeadingHorizontal ? startGlobal.y + p : startGlobal.y,
            });
            if (!startIsSpecial) {
                startIsSpecial = true;
                for (const s of segments) if (s.index > 1) s.index += 1;
            }
        } else {
            newPoints.unshift({
                x: !secondIsHorizontal ? second.x : startGlobal.x,
                y: secondIsHorizontal ? second.y : startGlobal.y,
            });
            if (startIsSpecial) {
                startIsSpecial = false;
                for (const s of segments) if (s.index > 1) s.index -= 1;
            }
        }
        newPoints.unshift({ ...startGlobal });
    }

    // End tail (elbowArrow.ts:816-870): symmetric push. A tail insert shifts no existing indices.
    {
        const secondToLast = src[src.length - (endIsSpecial ? 3 : 2)];
        const thirdToLast = src[src.length - (endIsSpecial ? 4 : 3)];
        const secondIsHorizontal = headingIsHorizontalVec(thirdToLast, secondToLast);
        if (ctx.endBound && ctx.endHeadingHorizontal === secondIsHorizontal) {
            const p = ctx.endHeadingPositive ? BASE_PADDING : -BASE_PADDING;
            newPoints.push({
                x: !secondIsHorizontal ? thirdToLast.x : endGlobal.x + p,
                y: secondIsHorizontal ? thirdToLast.y : endGlobal.y + p,
            });
            newPoints.push({
                x: ctx.endHeadingHorizontal ? endGlobal.x + p : endGlobal.x,
                y: !ctx.endHeadingHorizontal ? endGlobal.y + p : endGlobal.y,
            });
            endIsSpecial = true;
        } else {
            newPoints.push({
                x: !secondIsHorizontal ? secondToLast.x : endGlobal.x,
                y: secondIsHorizontal ? secondToLast.y : endGlobal.y,
            });
            endIsSpecial = false;
        }
        newPoints.push({ ...endGlobal });
    }

    return normalizeElbowUpdate(newPoints, segments, startIsSpecial, endIsSpecial);
}

// --- unpin --------------------------------------------------------------------------

// Remove the pin at `index`. Removing the LAST pin returns the arrow to derived mode (points collapse to
// the two endpoints, fixedSegments ''); the derived route takes over — visually what Excalidraw's release
// does with no neighbour pins. Removing a non-last pin drops the constraint and renormalizes, keeping the
// polyline where it is (the gap-reroute of handleSegmentRelease is deferred with the multi-pin UI).
export function unpinSegment(arrow: VectorArrowElement, index: number): PinPatch {
    const w = toWorking(arrow);
    const remaining = w.segments.filter((s) => s.index !== index);
    if (remaining.length === 0) {
        return derivedPatch(w.points[0], w.points[w.points.length - 1]);
    }
    const dropped: VectorArrowElement = {
        ...arrow,
        fixedSegments: serializeFixedSegments({
            segments: remaining.map((s) => ({
                index: s.index,
                start: [s.start.x - arrow.x, s.start.y - arrow.y] as [number, number],
                end: [s.end.x - arrow.x, s.end.y - arrow.y] as [number, number],
            })),
            startIsSpecial: w.startIsSpecial,
            endIsSpecial: w.endIsSpecial,
        }),
    };
    return renormalize(dropped);
}
