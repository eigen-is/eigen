// The edits of a pinned elbow arrow, one where the user has fixed some segments in place. Such an arrow stores its
// whole routed line in `points`, so each edit changes those points directly, such as sliding a dragged segment or
// moving an end after its shape. The code ports Excalidraw's elbow arrow editing. Each edit returns a patch, and
// the caller writes it, such as the canvas tools or followBindings.

import type { Point } from './geometry';
import { BASE_PADDING, DEDUP_THRESHOLD, headingIsHorizontalVec } from './heading';
import { parsePoints, serializePoints } from './points';
import type { FixedSegment, VectorArrowElement } from './types';
import { parseFixedSegments, serializeFixedSegments } from './types';

// The fields an edit of a pinned arrow changes. The caller writes them together.
export type PinPatch = {
    points: string;
    x: number;
    y: number;
    width: number;
    height: number;
    fixedSegments: string;
};

// What an edit at an end of the arrow needs to know: whether each end is bound, and which way it leaves. The
// caller builds it with elbowRoutingContext, so this file reads no shapes. Excalidraw's handleSegmentMove and
// handleEndpointDrag read the same facts from the start and end headings and the hovered elements. Each heading
// is split into two flags: whether it is horizontal, and whether it points right or down.
export type PinRoutingContext = {
    startBound: boolean;
    endBound: boolean;
    startHeadingHorizontal: boolean;
    startHeadingPositive: boolean;
    endHeadingHorizontal: boolean;
    endHeadingPositive: boolean;
};

// Both ends unbound, for a caller that passes no context. Only an edit at an end of the arrow reads it.
const UNBOUND_PIN_CONTEXT: PinRoutingContext = {
    startBound: false,
    endBound: false,
    startHeadingHorizontal: false,
    startHeadingPositive: false,
    endHeadingHorizontal: false,
    endHeadingPositive: false,
};

// A pinned arrow decoded into scene coordinates: its points, its pins, and the two flags that say an end carries
// an extra jog point. The edits work in the scene, and normalizeElbowUpdate turns the result back into local
// points.
type Working = {
    points: Point[];
    segments: WorkingSegment[];
    startIsSpecial: boolean;
    endIsSpecial: boolean;
};
type WorkingSegment = { index: number; start: Point; end: Point };

function pointsEqual(a: Point, b: Point): boolean {
    return a.x === b.x && a.y === b.y;
}

// Whether each segment runs straight across or straight down, within `tolerance`, as Excalidraw's
// validateElbowPoints. A line from a corrupt or foreign file must pass this before it is trusted as an elbow
// route.
export function validateElbowPoints(points: Point[], tolerance = DEDUP_THRESHOLD): boolean {
    for (let i = 1; i < points.length; i++) {
        const p = points[i];
        const q = points[i - 1];
        if (!(Math.abs(p.x - q.x) < tolerance || Math.abs(p.y - q.y) < tolerance)) return false;
    }
    return true;
}

function toWorking(arrow: VectorArrowElement): Working {
    const points = scenePoints(arrow);
    const parsed = parseFixedSegments(arrow.fixedSegments);
    const segments = parsed.segments.map((s) => sceneSegment(arrow, s));
    return { points, segments, startIsSpecial: parsed.startIsSpecial, endIsSpecial: parsed.endIsSpecial };
}

function scenePoints(arrow: VectorArrowElement): Point[] {
    return parsePoints(arrow.points).map((p) => ({ x: arrow.x + p.x, y: arrow.y + p.y }));
}

function sceneSegment(arrow: VectorArrowElement, s: FixedSegment): WorkingSegment {
    return {
        index: s.index,
        start: { x: arrow.x + s.start[0], y: arrow.y + s.start[1] },
        end: { x: arrow.x + s.end[0], y: arrow.y + s.end[1] },
    };
}

// Turns scene points back into a patch, as Excalidraw's normalizeArrowElementUpdate. The first point becomes the
// local origin. Each pin's two points are copied again from the points at its index, so the copies can't drift.
// With no pins left, fixedSegments serializes to '', and the arrow goes back to a derived route.
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
    const rebuilt = segments
        .filter((s) => s.index >= 1 && s.index < local.length)
        .map(
            (s): FixedSegment => ({
                index: s.index,
                start: [local[s.index - 1].x, local[s.index - 1].y],
                end: [local[s.index].x, local[s.index].y],
            }),
        );
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

// Adds or replaces the pin at `index`, as Excalidraw's moveFixedSegment. The segment moves only across its own
// direction. A horizontal segment keeps its x values and takes the cursor's y, and a vertical one keeps its y
// values and takes the cursor's x. It returns every pin in local coordinates, sorted by index.
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

// Rebuilds the points after a pin moved, as Excalidraw's handleSegmentMove. The dragged segment's two points take
// the pin's new place. Each neighboring segment stretches along its own direction, so a drag in the middle adds no
// corner. A pinned neighbor stays joined to the moved point. The first and last segments may never be pinned, so
// a drag of one of them adds a corner at that end. The pinned segment is then no longer the first or last, and
// the arrow's end stays where it was.
function handleSegmentMove(
    arrow: VectorArrowElement,
    segments: FixedSegment[],
    movedIndex: number,
    ctx: PinRoutingContext,
): PinPatch {
    const newPoints = scenePoints(arrow);
    const nextSegments = segments.map((s) => sceneSegment(arrow, s));
    const moved = nextSegments.find((s) => s.index === movedIndex);
    if (!moved) return normalizeElbowUpdate(newPoints, nextSegments, false, false);

    // The ends and the point count from before the edit. A bound end puts its old point back unchanged, and the
    // corners below test the old count.
    const lastIndex = newPoints.length - 1;
    const oldStart = { ...newPoints[0] };
    const oldEnd = { ...newPoints[lastIndex] };
    const oldPins = parseFixedSegments(arrow.fixedSegments).segments;
    const hasFirstPin = oldPins.some((s) => s.index === 1);
    const hasLastPin = oldPins.some((s) => s.index === lastIndex);

    // At a bound end, the pin's outer point first moves away from the shape along the end's heading, as in
    // Excalidraw's handleSegmentMove. The new corner then has room to leave the shape at a right angle. A short
    // segment moves by half its length instead of the full BASE_PADDING.
    const segmentLength = Math.hypot(moved.end.x - moved.start.x, moved.end.y - moved.start.y);
    const padding = segmentLength < BASE_PADDING + 5 ? segmentLength / 2 : BASE_PADDING;
    const pad = (positive: boolean): number => (positive ? padding : -padding);
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

    // Each neighbor's far point takes the moved point's coordinate across the neighbor's direction. A
    // horizontal neighbor takes the new y, and a vertical one the new x, so the neighbor stays straight.
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

    // A pinned neighbor follows the moved point, so no notch opens between the two pins.
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

    // A drag of the first segment adds a corner before it, so the pin is no longer the first segment. A bound
    // start also puts its old point back in front. Every pin's index then grows by the number of points added.
    // The corner lines up with the start's heading when the start is bound, and with the first segment otherwise.
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

    // A drag of the last segment adds a corner after it in the same way. Points added at the end change no
    // index. This corner turns along the end heading from the context, even when the end is unbound.
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

// One step of a segment drag on an arrow that is already pinned. It moves the pin at `index` to the cursor and
// rebuilds the points. The canvas calls it on every pointer move. On release it commits the last patch, after
// renormalize.
export function moveSegment(
    arrow: VectorArrowElement,
    index: number,
    cursorScene: Point,
    ctx: PinRoutingContext = UNBOUND_PIN_CONTEXT,
): PinPatch {
    const segments = moveFixedSegment(arrow, index, cursorScene);
    return handleSegmentMove(arrow, segments, index, ctx);
}

// The first pin of an arrow. Until now the arrow's route was derived, so this stores `route`, the current derived
// route in local coordinates, as its points. Then it pins the dragged segment. The patch turns the arrow into a
// pinned one.
export function materializeFirstPin(
    arrow: VectorArrowElement,
    route: Point[],
    index: number,
    cursorScene: Point,
    ctx: PinRoutingContext = UNBOUND_PIN_CONTEXT,
): PinPatch {
    const frozen: VectorArrowElement = { ...arrow, points: serializePoints(route), fixedSegments: '' };
    return moveSegment(frozen, index, cursorScene, ctx);
}

// Tidies a pinned arrow, as Excalidraw's handleSegmentRenormalization. Two neighboring segments in the same
// direction merge, a segment shorter than DEDUP_THRESHOLD goes, and a pin that ends up on the first or last
// segment is dropped. Every committed write of a pinned arrow runs it last. With no pin left, fixedSegments
// becomes '' and the arrow goes back to a derived route.
export function renormalize(arrow: VectorArrowElement): PinPatch {
    const w = toWorking(arrow);
    const { points, segments } = w;

    // First, drop each point between two segments that run the same direction.
    for (let i = points.length - 2; i >= 1; i--) {
        const currentHorizontal = headingIsHorizontalVec(points[i], points[i + 1]);
        const prevHorizontal = headingIsHorizontalVec(points[i - 1], points[i]);
        if (currentHorizontal !== prevHorizontal) continue;
        // A pin on the later segment stays and now starts where the earlier one did. A pin on the earlier
        // segment goes, and every pin above moves down one index.
        const here = segments.findIndex((s) => s.index === i + 1);
        const prevIdx = segments.findIndex((s) => s.index === i);
        if (here !== -1) segments[here].start = { ...points[i - 1] };
        if (prevIdx !== -1) segments.splice(prevIdx, 1);
        points.splice(i, 1);
        for (const s of segments) if (s.index > i) s.index -= 1;
    }

    // Then drop the segments shorter than DEDUP_THRESHOLD. Excalidraw removes both points of a short segment at
    // once. This loop removes one point at a time. Both reach the same points in the end, and only the steps in
    // between differ. That is fine, because renormalize runs only on a commit and never during a drag.
    for (let i = points.length - 2; i >= 1; i--) {
        if (Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) >= DEDUP_THRESHOLD) continue;
        const onIt = segments.findIndex((s) => s.index === i);
        if (onIt !== -1) segments.splice(onIt, 1);
        points.splice(i, 1);
        for (const s of segments) if (s.index > i) s.index -= 1;
    }

    // The first and last segments can't be pinned.
    const kept = segments.filter((s) => s.index !== 1 && s.index !== points.length - 1);
    return normalizeElbowUpdate(points, kept, kept.length > 0 && w.startIsSpecial, kept.length > 0 && w.endIsSpecial);
}

// The patch of an arrow that goes back to a derived route: just its two ends, placed as normalizeLinear places
// them at angle 0.
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

// Moves a pinned arrow's ends, as Excalidraw's handleEndpointDrag. The points in between and every pin stay as
// they are. Only the first and last points and their neighbors are built again, so each end meets its segment at
// a right angle. A `null` end stays where it is. A bound end whose heading runs the same direction as its
// neighboring segment needs an extra corner. That end then gets two extra points, and startIsSpecial or
// endIsSpecial records them. The next move removes them before it builds the end again, so repeated moves don't
// pile up corners. Run renormalize on the result.
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
    // The old points with only the two ends replaced. Both ends below are built from these.
    const src: Point[] = points.map((p, i) => (i === 0 ? startGlobal : i === n - 1 ? endGlobal : p));
    const segments = w.segments.map((s) => ({ index: s.index }));

    // Copy the points in between unchanged. How many points each end has to skip depends on its isSpecial flag.
    const offset = 2 + (startIsSpecial ? 1 : 0);
    const endOffset = 2 + (endIsSpecial ? 1 : 0);
    const newPoints: Point[] = [];
    while (newPoints.length + offset < src.length - endOffset) newPoints.push({ ...src[newPoints.length + offset] });

    // The second point moves in line with the new start. When the start is bound and its heading runs the same
    // direction as the second segment, two points go in instead, one BASE_PADDING out from the shape.
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

    // The end is built the same way. Points added at the end change no index.
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

// Removes the pin at `index`. When it was the only pin, the arrow goes back to a derived route, and the points
// shrink to its two ends. That looks like what Excalidraw's handleSegmentRelease does when no other pin is near.
// When other pins remain, the points stay where they are. Excalidraw routes the freed stretch again, and Eigen
// doesn't do that yet.
export function unpinSegment(arrow: VectorArrowElement, index: number): PinPatch {
    const w = toWorking(arrow);
    const remaining = w.segments.filter((s) => s.index !== index);
    if (remaining.length === 0) {
        return derivedPatch(w.points[0], w.points[w.points.length - 1]);
    }
    const dropped: VectorArrowElement = {
        ...arrow,
        fixedSegments: serializeFixedSegments({
            segments: remaining.map(
                (s): FixedSegment => ({
                    index: s.index,
                    start: [s.start.x - arrow.x, s.start.y - arrow.y],
                    end: [s.end.x - arrow.x, s.end.y - arrow.y],
                }),
            ),
            startIsSpecial: w.startIsSpecial,
            endIsSpecial: w.endIsSpecial,
        }),
    };
    return renormalize(dropped);
}
