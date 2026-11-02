// Pure scene-space geometry for the canvas, such as boxes and their bounds, shape hit tests, a linear
// element's points, arrowheads and resize math. It reads no element kind, so every kind module can build
// on it. `Box` is the transform core that hit-testing, bounds and the ObjectTransform primitive share.
// Angles are degrees at every boundary, and radian math never escapes a function body.

import { isTransparentFill, parseFill } from './fill';
import { getLineHeightPx } from './font-metrics';
import { distanceToSegment, pointInPolygon } from './outline';
import { DEG_TO_RAD, parsePoints, pointsBounds, serializePoints } from './points';
import type { Arrowhead, VectorArrowElement, VectorLinearElement } from './types';

export type Point = { x: number; y: number };

// Canonical transform core: top-left origin + size + rotation. Structurally identical to
// the stored element fields, so hosts pass stored fields straight through.
export type Box = { x: number; y: number; width: number; height: number; angle: number };

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export const ORIGIN: Point = { x: 0, y: 0 };

// Canvas interaction steps shared by vector + slides, in scene/document units: arrow-key nudge
// (Shift = large) and the duplicate/paste cascade offset. One source so the two apps' keymaps match.
export const NUDGE_STEP = 1;
export const NUDGE_STEP_LARGE = 5;
export const DUPLICATE_OFFSET = 10;
// A multi-image drop/paste staggers by this much instead, so a stack of natural-size images stays
// visible (the duplicate step is for identical copies; images need more).
export const IMAGE_CASCADE_OFFSET = 20;

export function boxCenter(box: Box): Point {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Rotate `point` around `center` by `angleDeg` (clockwise, y-down — matches SVG rotate()).
export function rotatePoint(point: Point, center: Point, angleDeg: number): Point {
    const rad = angleDeg * DEG_TO_RAD;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
        x: center.x + dx * cos - dy * sin,
        y: center.y + dx * sin + dy * cos,
    };
}

// Axis-aligned bounding box of a (possibly rotated) box — its four rotated corners.
export function getElementBounds(box: Box): Bounds {
    const corners: Point[] = [
        { x: box.x, y: box.y },
        { x: box.x + box.width, y: box.y },
        { x: box.x + box.width, y: box.y + box.height },
        { x: box.x, y: box.y + box.height },
    ];
    const points = box.angle === 0 ? corners : corners.map((c) => rotatePoint(c, boxCenter(box), box.angle));
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// Marquee (rubber-band) selection semantics, shared by slides + vector. Drag direction
// picks the mode — the AutoCAD/Figma convention — with slides' dashed border (intersect) vs solid
// (contain) as the visual signal.
export type MarqueeMode = 'contain' | 'intersect';

// Rightward drag (current x ≥ start x) = 'contain'; leftward = 'intersect'. Resolve from the RAW
// start/current x, before the marquee rect is normalized to a min-corner box (that loses direction).
export function marqueeMode(startX: number, currentX: number): MarqueeMode {
    return currentX < startX ? 'intersect' : 'contain';
}

// Does an element (its axis-aligned bounds) fall in the marquee under `mode`? contain = fully inside;
// intersect = the boxes overlap at all. Pure AABB math — hosts map their element + marquee to Bounds.
export function marqueeHits(bounds: Bounds, marquee: Bounds, mode: MarqueeMode): boolean {
    if (mode === 'contain') {
        return (
            bounds.minX >= marquee.minX &&
            bounds.minY >= marquee.minY &&
            bounds.maxX <= marquee.maxX &&
            bounds.maxY <= marquee.maxY
        );
    }
    return (
        bounds.minX < marquee.maxX &&
        bounds.maxX > marquee.minX &&
        bounds.minY < marquee.maxY &&
        bounds.maxY > marquee.minY
    );
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
    };
}

// Union bounds of several boxes (multi-select). Caller guarantees a non-empty list.
export function getElementsBounds(boxes: Box[]): Bounds {
    return boxes.map(getElementBounds).reduce(unionBounds);
}

// Map a scene point into the box's unrotated local frame, so every hit-test works on an
// axis-aligned shape.
function toLocal(box: Box, point: Point): Point {
    return box.angle === 0 ? point : rotatePoint(point, boxCenter(box), -box.angle);
}

export function hitTestBox(box: Box, point: Point): boolean {
    const p = toLocal(box, point);
    return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
}

export function hitTestEllipse(box: Box, point: Point): boolean {
    const rx = box.width / 2;
    const ry = box.height / 2;
    if (rx === 0 || ry === 0) return false;
    const p = toLocal(box, point);
    const nx = (p.x - (box.x + rx)) / rx;
    const ny = (p.y - (box.y + ry)) / ry;
    return nx * nx + ny * ny <= 1;
}

export function hitTestDiamond(box: Box, point: Point): boolean {
    const rx = box.width / 2;
    const ry = box.height / 2;
    if (rx === 0 || ry === 0) return false;
    const p = toLocal(box, point);
    return Math.abs(p.x - (box.x + rx)) / rx + Math.abs(p.y - (box.y + ry)) / ry <= 1;
}

// --- Linear elements (freedraw / line) ------------------------------------------------
// points is a JSON `[[x,y],…]` string, scene units relative to (x,y); the bbox min corner is (0,0).
// Kept a string in the model so a whole stroke is one scalar write (never a per-sample Y.Array).

// The full stroke diameter is `strokeWidth * FREEDRAW_SIZE_FACTOR`; hit-testing widens a freedraw's
// tolerance by half of it (the visible ink half-width). The renderer feeds the same factor to
// perfect-freehand's `size`.
export const FREEDRAW_SIZE_FACTOR = 2.125;

// A path loops when its ends meet: ≥ 3 points and the first ≈ last within 8 scene units
// (Excalidraw's isPathALoop at zoom 1 — zoom-free so FE preview and BE export decide fill alike).
const CLOSE_PATH_THRESHOLD = 8;

// Excalidraw's getElementHitThreshold: a linear/arrow element is grabbed within the LARGER of the
// zoom-scaled screen threshold (0.85× — Excalidraw's tested floor; lower gets FP-flaky at high zoom)
// and half the drawn ink width plus 0.1.
export const LINEAR_HIT_SCREEN_FACTOR = 0.85;

// Hit tolerance in screen px (Excalidraw's DEFAULT_COLLISION_THRESHOLD); hosts divide by zoom so an
// element's grab radius is a constant on-screen distance at any zoom.
export const HIT_THRESHOLD_SCREEN = 8;

// A coarse pointer (finger/stylus) has no pixel-precise tip, so it grabs within a fatter screen radius
// than a mouse. Excalidraw keeps a constant threshold — this multiplier is our own touch addition, kept
// to a single knob applied wherever HIT_THRESHOLD_SCREEN feeds hover/hit-testing/eraser.
export const COARSE_HIT_SLOP_MULTIPLIER = 1.75;

// The screen-px grab tolerance for the active pointer: the base for a mouse, fattened for coarse
// pointers. Callers still divide by zoom. One source so hover/hit and the eraser can never drift apart.
export function hitThresholdScreen(coarse: boolean): number {
    return coarse ? HIT_THRESHOLD_SCREEN * COARSE_HIT_SLOP_MULTIPLIER : HIT_THRESHOLD_SCREEN;
}

// Per-point pen pressure, the parallel array to a freedraw's points (Excalidraw's `pressures`). Any
// structural garbage or a non-finite/non-number entry ⇒ [] (the caller then falls back to simulate);
// finite values clamp to [0,1]. Kept a JSON string like points so a whole stroke is one scalar write.
export function parsePressures(pressures: string): number[] {
    let raw: unknown;
    try {
        raw = JSON.parse(pressures);
    } catch {
        return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: number[] = [];
    for (const p of raw) {
        if (typeof p !== 'number' || !Number.isFinite(p)) return [];
        out.push(Math.min(1, Math.max(0, p)));
    }
    return out;
}

export function serializePressures(pressures: number[]): string {
    return JSON.stringify(pressures.map((p) => round3(Math.min(1, Math.max(0, p)))));
}

// Pressures are 0..1, so 2-decimal point rounding would flatten the width variation — keep 3 decimals.
function round3(n: number): number {
    const r = Math.round(n * 1000) / 1000;
    return r === 0 ? 0 : r;
}

// Re-derive (x, y, width, height, points) so the point bbox's MIN corner is the origin (every point
// non-negative) and width/height span the raw bbox — so the box ALWAYS equals the content and bounds,
// viewBox, selection ring, rotation pivot and hit-testing agree with no special case. `box` is the
// element's CURRENT box (its width/height only matter when rotated): the renderer rotates about the
// box center, so translating the points by -min AND changing the extent both move that pivot; x/y
// shift so every point keeps its scene position (Excalidraw's _updatePoints center correction).
export function normalizeLinear(
    box: Box,
    points: Point[],
): { x: number; y: number; width: number; height: number; points: string } {
    if (points.length === 0) return { x: box.x, y: box.y, width: 0, height: 0, points: '[]' };

    const b = pointsBounds(points);
    const width = b.maxX - b.minX;
    const height = b.maxY - b.minY;
    const shifted = points.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY }));
    const center = boxCenter(box);
    const d = rotatePoint(
        { x: b.minX + (width - box.width) / 2, y: b.minY + (height - box.height) / 2 },
        ORIGIN,
        box.angle,
    );
    return {
        x: center.x + d.x - width / 2,
        y: center.y + d.y - height / 2,
        width,
        height,
        points: serializePoints(shifted),
    };
}

// Scale points per axis to fit a new box (ObjectTransform resize). Scaling is about the origin (0,0),
// the bbox min corner, so non-negative points stay non-negative; a degenerate old dimension keeps that
// axis (nothing to scale from). resizeLinear re-normalizes after, so the invariant holds regardless.
export function rescalePoints(
    points: Point[],
    oldSize: { width: number; height: number },
    newSize: { width: number; height: number },
): Point[] {
    const sx = oldSize.width === 0 ? 1 : newSize.width / oldSize.width;
    const sy = oldSize.height === 0 ? 1 : newSize.height / oldSize.height;
    return points.map((p) => ({ x: p.x * sx, y: p.y * sy }));
}

// Every width/height write on a linear element goes through here: rescale the points to the new box
// per axis, then re-normalize so the bbox min corner stays the origin. The one owner of resize for the
// canvas onCommit, the panel's W/H inputs, and match-size.
export function resizeLinear(
    el: VectorLinearElement | VectorArrowElement,
    box: Box,
): { x: number; y: number; width: number; height: number; points: string } {
    return normalizeLinear(box, rescalePoints(parsePoints(el.points), el, box));
}

// Distance between two points. Every tool that measures a drag, a grab radius or a segment length
// asks this rather than spelling out its own Math.hypot.
export function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// Nearest distance from a point to a polyline (min over its segments). A single point degrades to the
// distance to that point; an empty path is unreachable.
export function distanceToPolyline(points: Point[], point: Point): number {
    if (points.length === 0) return Number.POSITIVE_INFINITY;
    if (points.length === 1) return distance(point, points[0]);
    let min = Number.POSITIVE_INFINITY;
    for (let i = 1; i < points.length; i++) {
        const d = distanceToSegment(point, points[i - 1], points[i]);
        if (d < min) min = d;
    }
    return min;
}

// The polyline kinds' hit test: the probe unrotated into the element's local frame, measured to the
// polyline within the LARGER of the scaled screen threshold and the drawn ink half-width (+0.1); a
// closed, filled path is also hit anywhere inside. `inkHalf` differs per kind — freedraw's stroke is
// FREEDRAW_SIZE_FACTOR wider than its strokeWidth.
export function hitTestLinear(el: VectorLinearElement, point: Point, threshold: number, inkHalf: number): boolean {
    const points = parsePoints(el.points);
    if (points.length === 0) return false;
    const p = linearSceneToLocal(el, point);
    if (distanceToPolyline(points, p) <= Math.max(threshold * LINEAR_HIT_SCREEN_FACTOR, inkHalf + 0.1)) return true;
    return isClosedPath(points) && !isTransparentFill(parseFill(el.fill)) && pointInPolygon(p, points);
}

export function isClosedPath(points: Point[]): boolean {
    if (points.length < 3) return false;
    const first = points[0];
    const last = points[points.length - 1];
    return distance(first, last) <= CLOSE_PATH_THRESHOLD;
}

// Does this freedraw/line paint a fill at all? Only a looping path does — the rule the renderers apply
// (freedraw's render arm and linearRoughOptions, both on the points they already hold), so the kind's
// per-element `fill` capability answers through the same predicate and the panel offers the Fill block
// exactly when the paint would land.
export function isClosedLinear(el: VectorLinearElement): boolean {
    return isClosedPath(parsePoints(el.points));
}

// A linear element's local frame ↔ scene mapping. The renderer places every vertex at
// rotate(origin + local, boxCenter, angle), so hit-testing and the point-handles share this one
// transform — the pivot convention lives here, not copied at each call site.
export function linearSceneToLocal(box: Box, scene: Point): Point {
    const un = rotatePoint(scene, boxCenter(box), -box.angle);
    return { x: un.x - box.x, y: un.y - box.y };
}

export function linearLocalToScene(box: Box, local: Point): Point {
    return rotatePoint({ x: box.x + local.x, y: box.y + local.y }, boxCenter(box), box.angle);
}

// --- Arrows: the curve, heads and labels -------------------------------------------

type CubicBezier = [Point, Point, Point, Point];

// The arrow curve's parametric form — the ONE geometry-side owner of the shape roughjs's `gen.curve`
// draws for a round (non-elbow) arrow. Golden-locked by test to roughjs's `_curve` control points at
// roughness 0: a uniform Catmull-Rom cardinal spline (curveTightness 0 ⇒ s = 1) with the first and last
// points duplicated so the shaft passes through its endpoints. `points` must have ≥ 2 entries.
export function arrowCurveBeziers(points: Point[]): CubicBezier[] {
    const ps = [points[0], points[0], ...points.slice(1), points[points.length - 1]];
    const beziers: CubicBezier[] = [];
    for (let i = 1; i + 2 < ps.length; i++) {
        const p0 = ps[i - 1];
        const p1 = ps[i];
        const p2 = ps[i + 1];
        const p3 = ps[i + 2];
        beziers.push([
            p1,
            { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
            { x: p2.x + (p1.x - p3.x) / 6, y: p2.y + (p1.y - p3.y) / 6 },
            p2,
        ]);
    }
    return beziers;
}

const ARROWHEAD_SIZE = 15;
const ARROWHEAD_SIZE_LONG = 25; // the plain 'arrow' head is longer

type ArrowheadGeometry =
    | { kind: 'barbs'; tip: Point; barb1: Point; barb2: Point }
    | { kind: 'circle'; center: Point; diameter: number };

// Head geometry in the arrow's local frame, from the direction of the raw last or first segment. Excalidraw
// reads the curve roughjs draws instead, so on a curved shaft the two can differ a little. The head is
// capped at half its segment so a short arrow's head shrinks instead of overrunning it. 'barbs' feeds
// the arrow (two lines), bar (one line) and triangle (filled polygon); 'circle' a filled disc.
export function arrowheadGeometry(
    el: VectorArrowElement,
    points: Point[],
    position: 'start' | 'end',
    head: Arrowhead,
): ArrowheadGeometry | null {
    if (head === 'none' || points.length < 2) return null;
    const tip = position === 'end' ? points[points.length - 1] : points[0];
    const prev = position === 'end' ? points[points.length - 2] : points[1];
    const dx = tip.x - prev.x;
    const dy = tip.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const size = head === 'arrow' ? ARROWHEAD_SIZE_LONG : ARROWHEAD_SIZE;
    const minSize = Math.min(size, len * 0.5);
    const base = { x: tip.x - (dx / len) * minSize, y: tip.y - (dy / len) * minSize };
    // Floored at 1: a thin, short arrow's span + strokeWidth − 2 can go non-positive (no disc at all).
    if (head === 'circle') return { kind: 'circle', center: tip, diameter: Math.max(1, minSize + el.strokeWidth - 2) };
    const angle = head === 'bar' ? 90 : head === 'arrow' ? 20 : 25;
    return { kind: 'barbs', tip, barb1: rotatePoint(base, tip, -angle), barb2: rotatePoint(base, tip, angle) };
}

// The clearance an arrow label's mask leaves around its text, on every side.
export const ARROW_LABEL_PAD = 5;

// The label's center (arrow local frame) and box: centered on the polyline's index-midpoint (odd → the
// middle vertex, even → the middle segment's midpoint), width client-measured (labelWidth),
// height = line count × the font's line height. null when the arrow has no label. Shared by hit-testing,
// bounds, and the renderer so the three agree. `route` overrides the stored points for an elbow arrow (its
// label rides the derived route's midpoint).
export function arrowLabelBox(
    el: VectorArrowElement,
    route?: Point[],
): { center: Point; width: number; height: number } | null {
    if (el.text === '') return null;
    const center = arrowLabelCenter(el, route);
    if (!center) return null;
    const lines = el.text.replace(/\r\n?/g, '\n').split('\n').length;
    return {
        center,
        width: el.labelWidth,
        height: lines * getLineHeightPx(el.fontFamily, el.fontSize),
    };
}

// The label anchor in the arrow's local frame: the polyline's index-midpoint (odd → the middle vertex,
// even → the middle segment's midpoint). null for a degenerate arrow (< 2 points). Text-free
// so the editor can center an empty label on the same anchor a committed one would render at. `route` (the
// derived elbow polyline) overrides the stored points when given.
export function arrowLabelCenter(el: VectorArrowElement, route?: Point[]): Point | null {
    const points = route ?? parsePoints(el.points);
    if (points.length < 2) return null;
    const n = points.length;
    if (n % 2 === 1) return points[(n - 1) / 2];
    const i = n / 2;
    return { x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2 };
}

// --- Resize / rotate transform math ---------------------------------------------------
// The resize floor is a `minSize` PARAMETER rather than a module constant, so the same math serves a
// fixed-unit deck and a zoomable canvas (which passes ~1).
// Angle is DEGREES throughout — no radian value escapes a function body (rotatePoint owns it).

// Resize an axis-aligned box by dragging one handle. The opposite corner/edge stays pinned
// (unless fromCenter). `mode` is a 'resize-<dir>' string. Angle is passed through unchanged
// — callers use resizeRotatedRect for rotated boxes.
export function applyResize(
    mode: string,
    dx: number,
    dy: number,
    { x: ox, y: oy, width: ow, height: oh, angle }: Box,
    { fromCenter, keepAspect }: { fromCenter: boolean; keepAspect: boolean },
    minSize: number,
): Box {
    // Strip the 'resize-' prefix first — 'resize' itself contains 'e' and 's', poisoning the substring check.
    const dir = mode?.split('-')[1] ?? '';
    const xDir = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
    const yDir = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
    // Aspect lock only applies to corners — on edges only one axis is intentional.
    const aspectLocked = keepAspect && xDir !== 0 && yDir !== 0 && ow > 0 && oh > 0;

    let dw = xDir * dx;
    let dh = yDir * dy;

    if (aspectLocked) {
        const aspect = ow / oh;
        if (Math.abs(dw / ow) >= Math.abs(dh / oh)) {
            dh = dw / aspect;
        } else {
            dw = dh * aspect;
        }
    }

    const sizeFactor = fromCenter ? 2 : 1;
    let w = ow + sizeFactor * dw;
    let h = oh + sizeFactor * dh;

    if (aspectLocked) {
        // Clamp both dimensions through a single scale so the ratio survives the minSize floor.
        const scale = Math.max(w / ow, minSize / ow, minSize / oh);
        w = ow * scale;
        h = oh * scale;
    } else {
        w = Math.max(minSize, w);
        h = Math.max(minSize, h);
    }

    let x: number;
    let y: number;
    if (fromCenter) {
        x = ox + (ow - w) / 2;
        y = oy + (oh - h) / 2;
    } else {
        x = xDir === -1 ? ox + ow - w : ox;
        y = yDir === -1 ? oy + oh - h : oy;
    }

    return { x, y, width: w, height: h, angle };
}

// Resize a rotated box: the dragged handle's opposite corner/edge stays fixed in world
// space and the box grows along its own (rotated) axes. Reuses applyResize in a
// center-origin local frame, then repositions the center so the pinned point holds. At
// angle 0 this returns exactly applyResize(...). Rotation is read from the box itself.
export function resizeRotatedRect(
    mode: string,
    dx: number,
    dy: number,
    start: Box,
    opts: { fromCenter: boolean; keepAspect: boolean },
    minSize: number,
): Box {
    const rotation = start.angle;
    if (!rotation) return applyResize(mode, dx, dy, start, opts, minSize);
    const cx = start.x + start.width / 2;
    const cy = start.y + start.height / 2;
    // Rotate the pointer delta into the box's unrotated frame (rotatePoint around ORIGIN is a
    // pure vector rotation — reused rather than a second helper).
    const local = rotatePoint({ x: dx, y: dy }, ORIGIN, -rotation);
    const r = applyResize(
        mode,
        local.x,
        local.y,
        { x: -start.width / 2, y: -start.height / 2, width: start.width, height: start.height, angle: 0 },
        opts,
        minSize,
    );
    const dCenter = rotatePoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, ORIGIN, rotation);
    return {
        x: cx + dCenter.x - r.width / 2,
        y: cy + dCenter.y - r.height / 2,
        width: r.width,
        height: r.height,
        angle: rotation,
    };
}

// Snap an angle (degrees) to the nearest `step` — used for Shift → 15° rotation.
export function snapAngle(deg: number, step = 15): number {
    return Math.round(deg / step) * step;
}
