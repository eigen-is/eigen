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

const DEDUP_THRESHOLD = 1;

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

// Excalidraw's handleSegmentMove (interior path): overwrite the dragged pin's two vertices, stretch each
// neighbour's far endpoint along the neighbour's own axis (so no new corner appears), and weld any
// adjacent pinned segment to the moved vertex. Excalidraw's first/last-segment jog branch is OMITTED — v1
// pins are interior-only, so a first/last segment is never dragged. `movedIndex` is the pin the caller just dragged.
function handleSegmentMove(arrow: VectorArrowElement, segments: FixedSegment[], movedIndex: number): PinPatch {
    const newPoints: Point[] = parsePoints(arrow.points).map((p) => ({ x: arrow.x + p.x, y: arrow.y + p.y }));
    const nextSegments: WorkingSegment[] = segments.map((s) => ({
        index: s.index,
        start: { x: arrow.x + s.start[0], y: arrow.y + s.start[1] },
        end: { x: arrow.x + s.end[0], y: arrow.y + s.end[1] },
    }));
    const moved = nextSegments.find((s) => s.index === movedIndex);
    if (!moved) return normalizeElbowUpdate(newPoints, nextSegments, false, false);

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

    return normalizeElbowUpdate(newPoints, nextSegments, false, false);
}

// One gesture step: move the pin at `index` to the cursor and rebuild the polyline. The UI calls this
// per pointermove on an already-pinned arrow; the patch it returns is what release commits (after renormalization).
export function moveSegment(arrow: VectorArrowElement, index: number, cursorScene: Point): PinPatch {
    const segments = moveFixedSegment(arrow, index, cursorScene);
    return handleSegmentMove(arrow, segments, index);
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
): PinPatch {
    // The frozen arrow: points now the full route, still no pins — the base moveSegment mutates.
    const frozen: VectorArrowElement = { ...arrow, points: serializePoints(route), fixedSegments: '' };
    return moveSegment(frozen, index, cursorScene);
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

// Move a pinned arrow's endpoint(s) (Excalidraw's handleEndpointDrag, else-branch): the interior points —
// and every pin — are kept VERBATIM; only the start pair and the end pair are recomputed so the connector
// re-drops orthogonally onto the new endpoint. `null` keeps that endpoint. The heading-parallel L-jog
// (startIsSpecial/endIsSpecial) is deferred with the interior-only dot policy; renormalization on
// commit cleans any degenerate joint the projection leaves. Returns a full patch (run renormalize after).
export function moveEndpoints(arrow: VectorArrowElement, newStart: Point | null, newEnd: Point | null): PinPatch {
    const w = toWorking(arrow);
    const points = w.points.map((p) => ({ ...p }));
    const n = points.length;
    if (n < 4) return normalizeElbowUpdate(points, w.segments, w.startIsSpecial, w.endIsSpecial);

    if (newStart) {
        // The second segment (points[1]→points[2]) keeps its axis; the new second point re-drops from the
        // new start onto that axis (else-branch of handleEndpointDrag).
        const secondHorizontal = headingIsHorizontalVec(points[1], points[2]);
        const newSecond = {
            x: secondHorizontal ? newStart.x : points[1].x,
            y: secondHorizontal ? points[1].y : newStart.y,
        };
        points[0] = { ...newStart };
        points[1] = newSecond;
    }
    if (newEnd) {
        const secondHorizontal = headingIsHorizontalVec(points[n - 3], points[n - 2]);
        const newSecondToLast = {
            x: secondHorizontal ? newEnd.x : points[n - 2].x,
            y: secondHorizontal ? points[n - 2].y : newEnd.y,
        };
        points[n - 1] = { ...newEnd };
        points[n - 2] = newSecondToLast;
    }

    // Point count is unchanged, so pin indices carry over; normalizeElbowUpdate rebuilds their coords.
    return normalizeElbowUpdate(points, w.segments, w.startIsSpecial, w.endIsSpecial);
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
