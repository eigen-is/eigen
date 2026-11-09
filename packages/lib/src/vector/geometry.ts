// The pure geometry of the canvas, such as boxes and their bounds, shape hit tests, a linear element's points,
// arrowheads, arrow labels and resize math. It reads no element kind, so every kind module can build on it, and
// the code that asks a kind for its bounds or its outline sits on top of it. Angles are degrees wherever a value
// enters or leaves a function, and radians stay inside function bodies.

import { isTransparentFill, parseFill } from './fill';
import { getLineHeightPx } from './font-metrics';
import { distanceToSegment, pointInPolygon } from './outline';
import { DEG_TO_RAD, parsePoints, pointsBounds, serializePoints } from './points';
import type { Arrowhead, VectorArrowElement, VectorLinearElement } from './types';

export type Point = { x: number; y: number };

// The transform every element shares: its top-left corner, its size and its rotation. The stored element fields
// have the same shape, so a host passes an element where a Box is asked for. Hit tests, bounds and the
// ObjectTransform primitive all work on it.
export type Box = { x: number; y: number; width: number; height: number; angle: number };

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export const ORIGIN: Point = { x: 0, y: 0 };

// The step an arrow key moves a selection by, in scene units, and the larger step with Shift. Every canvas host
// reads them here, so the keymaps match.
export const NUDGE_STEP = 1;
export const NUDGE_STEP_LARGE = 5;
// How far a duplicate or a paste lands from its source.
export const DUPLICATE_OFFSET = 10;
// How far each image of a multi-image drop or paste lands from the one before. Images arrive at their natural
// size, so they need a wider step than duplicates for the stack to stay visible.
export const IMAGE_CASCADE_OFFSET = 20;

export function boxCenter(box: Box): Point {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// A positive angle turns clockwise on screen, because y points down. SVG's rotate() turns the same way.
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

// The axis-aligned bounds of a box, taken over its four corners after rotation.
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

// How a marquee selects. In 'contain' mode it takes the elements that lie fully inside it. In 'intersect' mode it
// takes every element it touches. The drag direction picks the mode, as in AutoCAD and Figma.
export type MarqueeMode = 'contain' | 'intersect';

// A drag to the right selects by containment, and a drag to the left by intersection. Pass the raw start and
// current x of the drag. Once the marquee is turned into a box with its corner at the minimum, the direction is
// gone.
export function marqueeMode(startX: number, currentX: number): MarqueeMode {
    return currentX < startX ? 'intersect' : 'contain';
}

// Whether an element's axis-aligned bounds fall in the marquee under `mode`.
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

// The bounds around several boxes. The list must not be empty, because reduce has no start value.
export function getElementsBounds(boxes: Box[]): Bounds {
    return boxes.map(getElementBounds).reduce(unionBounds);
}

// Turns a scene point back by the box's rotation, so each hit test below can treat the shape as unturned.
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

// A linear element, such as a line or a freehand stroke, stores its points as a JSON string of [x, y] pairs. They
// are relative to the element's x and y, and the corner of their bounds sits at 0, 0. A string makes a whole
// stroke one write to the shared document, instead of one write per sample.

// A freehand stroke's ink is this many times its strokeWidth across. The renderer passes the same width to
// perfect-freehand, and the hit test reaches half of it on each side.
export const FREEDRAW_SIZE_FACTOR = 2.125;

// A path is a loop when it has at least 3 points and its last point lies this close to its first, as in
// Excalidraw's isPathALoop at zoom 1. It ignores zoom, so the editor and a server export agree on whether a
// path fills.
const CLOSE_PATH_THRESHOLD = 8;

// As Excalidraw's getElementHitThreshold, a line or an arrow is hit within 0.85 of the screen threshold, or
// within half its ink width when that is larger. Excalidraw's tests hold at 0.85. A lower factor fails on
// floating-point noise at high zoom.
export const LINEAR_HIT_SCREEN_FACTOR = 0.85;

// How near a pointer must come to grab an element, in screen pixels, as Excalidraw's
// DEFAULT_COLLISION_THRESHOLD. A host divides it by the zoom, so the reach looks the same at every zoom.
const HIT_THRESHOLD_SCREEN = 8;

// A finger or a stylus can't point as precisely as a mouse, so a coarse pointer grabs from further away.
// Excalidraw has no such factor. It is our own addition for touch.
const COARSE_HIT_SLOP_MULTIPLIER = 1.75;

// The grab reach in screen pixels for the current pointer. Hover, the hit test and the eraser all read it, so
// they can't disagree. A caller still divides it by the zoom.
export function hitThresholdScreen(coarse: boolean): number {
    return coarse ? HIT_THRESHOLD_SCREEN * COARSE_HIT_SLOP_MULTIPLIER : HIT_THRESHOLD_SCREEN;
}

// A freehand stroke's pen pressure per point, as Excalidraw's `pressures`. It is stored as a JSON string for the
// same reason as the points. A value that isn't a list of finite numbers reads as an empty list, and the
// renderer then simulates the pressure. Each value is clamped to the range 0 to 1.
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

// Points round to 2 decimals. Pressures lie between 0 and 1, where 2 decimals would flatten the changes in width,
// so pressures keep 3.
function round3(n: number): number {
    const r = Math.round(n * 1000) / 1000;
    return r === 0 ? 0 : r;
}

// Sets a linear element's box to fit its points exactly. The points move so the corner of their bounds is at
// 0, 0, and the width and height span them. Then the bounds, the selection ring, the rotation pivot and the hit
// test all agree without a special case. `box` is the element's current box. The renderer rotates about the box
// center, and both the shift and the new size move that center. So x and y move too, and every point keeps its
// place in the scene, as in Excalidraw's _updatePoints.
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

// Scales points on each axis to fit a new size. They scale about 0, 0, the corner of their bounds, so no point
// goes negative. An axis whose old size is 0 has nothing to scale from, so it stays as it is.
function rescalePoints(
    points: Point[],
    oldSize: { width: number; height: number },
    newSize: { width: number; height: number },
): Point[] {
    const sx = oldSize.width === 0 ? 1 : newSize.width / oldSize.width;
    const sy = oldSize.height === 0 ? 1 : newSize.height / oldSize.height;
    return points.map((p) => ({ x: p.x * sx, y: p.y * sy }));
}

// Every write of a linear element's width or height goes through here, such as a drag on the canvas or the
// panel's size inputs. Writing the size alone would leave the points where they were.
export function resizeLinear(
    el: VectorLinearElement | VectorArrowElement,
    box: Box,
): { x: number; y: number; width: number; height: number; points: string } {
    return normalizeLinear(box, rescalePoints(parsePoints(el.points), el, box));
}

export function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// A polyline of one point is that point. An empty one is infinitely far away, so nothing hits it.
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

// The hit test of the kinds drawn as a polyline. A point hits within the reach LINEAR_HIT_SCREEN_FACTOR sets, and
// a closed path with a fill is also hit anywhere inside. Each kind passes `inkHalf`, half its drawn ink width,
// because a freehand stroke draws wider than its strokeWidth.
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

// Whether a line or a freehand stroke paints its fill. Only a closed path does, and the renderers apply the same
// rule. The kind's `fill` capability asks this, so the panel offers a fill only where it would show.
export function isClosedLinear(el: VectorLinearElement): boolean {
    return isClosedPath(parsePoints(el.points));
}

// The renderer places each point of a linear element at x and y plus the point, turned about the box center. The
// hit test and the point handles map between the scene and the points through these two functions, so they use
// the same pivot.
export function linearSceneToLocal(box: Box, scene: Point): Point {
    const un = rotatePoint(scene, boxCenter(box), -box.angle);
    return { x: un.x - box.x, y: un.y - box.y };
}

export function linearLocalToScene(box: Box, local: Point): Point {
    return rotatePoint({ x: box.x + local.x, y: box.y + local.y }, boxCenter(box), box.angle);
}

type CubicBezier = [Point, Point, Point, Point];

// The curve a round arrow draws, as Bézier pieces, for code that needs the shape itself, such as an export. It
// is the curve roughjs's `gen.curve` draws at roughness 0, and a test holds it to those control points. That is
// a Catmull-Rom spline at curveTightness 0. The first and last points are doubled, so the curve passes through
// both ends. `points` needs at least 2 entries.
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
// The plain arrow head is longer than the others.
const ARROWHEAD_SIZE_LONG = 25;

type ArrowheadGeometry =
    | { kind: 'barbs'; tip: Point; barb1: Point; barb2: Point }
    | { kind: 'circle'; center: Point; diameter: number };

// A head's points in the arrow's local frame. Its direction comes from the first or last segment of the points.
// Excalidraw reads the curve roughjs draws instead, so on a curved shaft the two can differ a little. A head is
// at most half its segment long, so on a short arrow it shrinks instead of overrunning the shaft. The arrow, bar
// and triangle heads draw from the barbs, and the circle head from its center and diameter.
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
    // On a thin, short arrow the diameter can reach 0 or less, and the disc would vanish. So it is at least 1.
    if (head === 'circle') return { kind: 'circle', center: tip, diameter: Math.max(1, minSize + el.strokeWidth - 2) };
    const angle = head === 'bar' ? 90 : head === 'arrow' ? 20 : 25;
    return { kind: 'barbs', tip, barb1: rotatePoint(base, tip, -angle), barb2: rotatePoint(base, tip, angle) };
}

// The clearance an arrow label's mask leaves around its text, on every side.
export const ARROW_LABEL_PAD = 5;

// The center and size of an arrow's label, in the arrow's local frame, or null when it has no label. The hit
// test, the bounds and the renderer all read it, so they agree. The width is labelWidth, which the browser
// measured. Pass `route` for an elbow arrow, whose label sits on its routed line.
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

// Where an arrow's label sits, in the arrow's local frame. With an odd number of points it is the middle point,
// and with an even number the middle of the middle segment. It is null for an arrow of fewer than 2 points. It
// ignores the text, so the editor can place an empty label where the finished one will show. Pass `route` for an
// elbow arrow.
export function arrowLabelCenter(el: VectorArrowElement, route?: Point[]): Point | null {
    const points = route ?? parsePoints(el.points);
    if (points.length < 2) return null;
    const n = points.length;
    if (n % 2 === 1) return points[(n - 1) / 2];
    const i = n / 2;
    return { x: (points[i - 1].x + points[i].x) / 2, y: (points[i - 1].y + points[i].y) / 2 };
}

// Resizes an unturned box by one dragged handle. The opposite corner or edge stays where it is, unless
// `fromCenter` grows the box from its center. `mode` names the handle, such as 'resize-se'. The angle passes
// through unchanged, and a turned box goes through resizeRotatedRect. The caller passes `minSize`, because a
// slide deck and a zoomable canvas need a different smallest size.
function applyResize(
    mode: string,
    dx: number,
    dy: number,
    { x: ox, y: oy, width: ow, height: oh, angle }: Box,
    { fromCenter, keepAspect }: { fromCenter: boolean; keepAspect: boolean },
    minSize: number,
): Box {
    // The word 'resize' itself contains an e and an s, so the direction checks below read only the part after it.
    const dir = mode.split('-')[1] ?? '';
    const xDir = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
    const yDir = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
    // The aspect lock applies only to a corner. An edge handle means to change one axis.
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
        // Both sides scale by one factor, so the ratio holds when minSize stops the shrink.
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

// Resizes a turned box. The box grows along its own turned axes, and the corner or edge opposite the dragged
// handle stays where it is in the scene. It runs applyResize on the unturned box centered on 0, 0, then moves the
// center so that opposite point holds still.
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
    const { x: cx, y: cy } = boxCenter(start);
    // Turning about the origin turns the pointer's movement without moving it.
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

// Holding Shift while rotating snaps the angle to steps of 15 degrees.
export function snapAngle(deg: number, step = 15): number {
    return Math.round(deg / step) * step;
}
