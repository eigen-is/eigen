// Pure scene-space geometry for eigen|vector>. Angle is DEGREES at every boundary;
// radian math never escapes a function body. `Box` is the canonical transform core shared
// by hit-testing, bounds, the properties bar, and (later) the shared ObjectTransform
// primitive.

import { isTransparent, type VectorElement, type VectorLinearElement } from './types';

export type Point = { x: number; y: number };

// Canonical transform core: top-left origin + size + rotation. Structurally identical to
// the stored element fields, so hosts pass stored fields straight through.
export type Box = { x: number; y: number; width: number; height: number; angle: number };

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

const DEG_TO_RAD = Math.PI / 180;

// Canvas interaction steps shared by vector + slides (U6f), in scene/document units: arrow-key nudge
// (Shift = large) and the duplicate/paste cascade offset. One source so the two apps' keymaps match.
export const NUDGE_STEP = 1;
export const NUDGE_STEP_LARGE = 5;
export const DUPLICATE_OFFSET = 10;

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

// Marquee (rubber-band) selection semantics, shared by slides + vector (U6c/D16). Drag direction
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
// perfect-freehand's `size`. One source, imported by scene-to-svg.
export const FREEDRAW_SIZE_FACTOR = 2.125;

// A path loops when its ends meet: ≥ 3 points and the first ≈ last within 8 scene units
// (Excalidraw's isPathALoop at zoom 1 — zoom-free so FE preview and BE export decide fill alike).
const CLOSE_PATH_THRESHOLD = 8;

export function parsePoints(points: string): Point[] {
    let raw: unknown;
    try {
        raw = JSON.parse(points);
    } catch {
        return [];
    }
    if (!Array.isArray(raw)) return [];
    const out: Point[] = [];
    for (const pair of raw) {
        if (!Array.isArray(pair)) return [];
        const [x, y] = pair;
        if (typeof x !== 'number' || typeof y !== 'number') return [];
        // A non-finite coord (e.g. 1e400 → Infinity via JSON overflow) drops just that point, not the
        // whole stroke — read-vector then clamps the survivors per axis.
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        out.push({ x, y });
    }
    return out;
}

export function serializePoints(points: Point[]): string {
    return JSON.stringify(points.map((p) => [round2(p.x), round2(p.y)]));
}

// Re-derive (x, y, width, height, points) so the point bbox's MIN corner is the origin (every point
// non-negative) and width/height span the raw bbox — so the box ALWAYS equals the content and bounds,
// viewBox, selection ring, rotation pivot and hit-testing agree with no special case. `box` is the
// element's CURRENT box (its width/height only matter when rotated): the renderer rotates about the
// box centre, so translating the points by -min AND changing the extent both move that pivot; x/y
// shift so every point keeps its scene position (Excalidraw's _updatePoints centre correction).
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
    el: VectorLinearElement,
    box: Box,
): { x: number; y: number; width: number; height: number; points: string } {
    return normalizeLinear(box, rescalePoints(parsePoints(el.points), el, box));
}

// Nearest distance from a point to a polyline (min over its segments). A single point degrades to the
// distance to that point; an empty path is unreachable.
export function distanceToPolyline(points: Point[], point: Point): number {
    if (points.length === 0) return Number.POSITIVE_INFINITY;
    if (points.length === 1) return Math.hypot(point.x - points[0].x, point.y - points[0].y);
    let min = Number.POSITIVE_INFINITY;
    for (let i = 1; i < points.length; i++) {
        const d = distanceToSegment(point, points[i - 1], points[i]);
        if (d < min) min = d;
    }
    return min;
}

export function isClosedPath(points: Point[]): boolean {
    if (points.length < 3) return false;
    const first = points[0];
    const last = points[points.length - 1];
    return Math.hypot(first.x - last.x, first.y - last.y) <= CLOSE_PATH_THRESHOLD;
}

export function hitTestElement(element: VectorElement, point: Point, threshold: number): boolean {
    switch (element.type) {
        case 'ellipse':
            return hitTestEllipse(element, point);
        case 'diamond':
            return hitTestDiamond(element, point);
        case 'rectangle':
        case 'text':
        case 'image':
            return hitTestBox(element, point);
        case 'freedraw':
        case 'line':
            return hitTestLinear(element, point, threshold);
    }
}

// A linear element's local frame ↔ scene mapping. The renderer places every vertex at
// rotate(origin + local, boxCentre, angle), so hit-testing and the point-handles share this one
// transform — the pivot convention lives here, not copied at each call site.
export function linearSceneToLocal(box: Box, scene: Point): Point {
    const un = rotatePoint(scene, boxCenter(box), -box.angle);
    return { x: un.x - box.x, y: un.y - box.y };
}

export function linearLocalToScene(box: Box, local: Point): Point {
    return rotatePoint({ x: box.x + local.x, y: box.y + local.y }, boxCenter(box), box.angle);
}

// Unrotate the probe into the element's local frame, then measure to the polyline. Tolerance is the
// screen threshold plus half the drawn ink width; a closed, filled path is also hit anywhere inside.
function hitTestLinear(element: VectorLinearElement, point: Point, threshold: number): boolean {
    const points = parsePoints(element.points);
    if (points.length === 0) return false;
    const p = linearSceneToLocal(element, point);

    const inkHalf =
        element.type === 'freedraw' ? (element.strokeWidth * FREEDRAW_SIZE_FACTOR) / 2 : element.strokeWidth / 2;
    if (distanceToPolyline(points, p) <= threshold + inkHalf) return true;
    return isClosedPath(points) && !isTransparent(element.backgroundColor) && pointInPolygon(p, points);
}

// Point-to-segment distance (Excalidraw's distanceToLineSegment): project onto the segment, clamp the
// parameter to [0,1], measure to the clamped foot.
function distanceToSegment(p: Point, a: Point, b: Point): number {
    const cx = b.x - a.x;
    const cy = b.y - a.y;
    const lenSq = cx * cx + cy * cy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * cx + (p.y - a.y) * cy) / lenSq));
    return Math.hypot(p.x - (a.x + t * cx), p.y - (a.y + t * cy));
}

// Even-odd ray cast, for inside-hits on a closed filled path.
function pointInPolygon(p: Point, points: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i];
        const b = points[j];
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

function pointsBounds(points: Point[]): Bounds {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const { x, y } of points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY };
}

function round2(n: number): number {
    const r = Math.round(n * 100) / 100;
    return r === 0 ? 0 : r;
}

// --- Resize / rotate transform math ---------------------------------------------------
// Ported verbatim from slides' app-local transform-geometry.ts (Rect{x,y,w,h} → canonical
// Box), with slides' module-level MIN_SIZE threaded as a `minSize` parameter so the same
// math serves a fixed-unit deck (slides passes 30) and a zoomable canvas (vector passes ~1).
// Angle is DEGREES throughout — no radian value escapes a function body (rotatePoint owns it).

const ORIGIN: Point = { x: 0, y: 0 };

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

// Normalize degrees into [0, 360) for storage.
export function normalizeAngle(deg: number): number {
    return ((deg % 360) + 360) % 360;
}
