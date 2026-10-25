// The canvas elements a chart is drawn as: rectangles, ellipses, pie slices and lines, made in the chart's paint.
// They are the canvas's own element types, so a bar paints exactly as a rectangle with the same fields, and Convert
// to shapes can unpack them. Each id is the chart's id and the shape's key, and each seed comes from both.

import { serializeFill, TRANSPARENT_COLOR, TRANSPARENT_FILL } from '../vector/fill';
import type { Box, Point } from '../vector/geometry';
import { pointsBounds, serializePoints } from '../vector/geometry';
import type {
    VectorElementBase,
    VectorEllipseElement,
    VectorLinearElement,
    VectorPieElement,
    VectorRectangleElement,
} from '../vector/types';
import type { Context } from './context';

const PIE_EDGE_WIDTH = 1;

// A hatch is strokes inside an outline, so a hatched bar, slice or swatch is outlined in its own color; a solid one
// draws none, as Google's do.
export function isOutlined(ctx: Context): boolean {
    return ctx.paint.fillStyle !== 'solid';
}

export function outlineOf(ctx: Context, color: string): string {
    return isOutlined(ctx) ? color : TRANSPARENT_COLOR;
}

export function rectangle(
    ctx: Context,
    key: string,
    box: Omit<Box, 'angle'>,
    strokeColor: string,
    fill: string,
): VectorRectangleElement {
    return { ...elementBase(ctx, key, box, strokeColor), type: 'rectangle', fill, corners: 'straight' };
}

export function ellipse(
    ctx: Context,
    key: string,
    box: Omit<Box, 'angle'>,
    strokeColor: string,
    fill: string,
): VectorEllipseElement {
    return { ...elementBase(ctx, key, box, strokeColor), type: 'ellipse', fill };
}

export function pieSlice(
    ctx: Context,
    key: string,
    box: Omit<Box, 'angle'>,
    strokeColor: string,
    fill: string,
    startAngle: number,
    sweepAngle: number,
): VectorPieElement {
    return {
        ...elementBase(ctx, key, box, strokeColor),
        strokeWidth: PIE_EDGE_WIDTH,
        type: 'pie',
        fill,
        startAngle,
        sweepAngle,
    };
}

// Points relative to the element's min corner.
export function line(
    ctx: Context,
    key: string,
    points: Point[],
    strokeColor: string,
    roundness: VectorLinearElement['roundness'],
    opacity = 100,
): VectorLinearElement & { type: 'line' } {
    const { minX, minY, maxX, maxY } = pointsBounds(points);
    return {
        ...elementBase(ctx, key, { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, strokeColor),
        opacity,
        type: 'line',
        fill: serializeFill(TRANSPARENT_FILL),
        points: serializePoints(points.map((p) => ({ x: p.x - minX, y: p.y - minY }))),
        roundness,
        pressures: '',
        simulatePressure: true,
    };
}

function elementBase(
    ctx: Context,
    key: string,
    box: Omit<Box, 'angle'>,
    strokeColor: string,
): Omit<VectorElementBase, 'type'> {
    return {
        id: `${ctx.id}:${key}`,
        ...box,
        angle: 0,
        index: '',
        frameId: '',
        commentCardIds: '',
        opacity: 100,
        strokeColor,
        strokeWidth: ctx.paint.strokeWidth,
        strokeStyle: 'solid',
        roughness: ctx.paint.roughness,
        seed: seedOf(ctx.paint.seed, key),
    };
}

// Seeds from the paint's seed and the shape's key, so a chart redraws the same jitter and no two of its
// shapes share one; never 0, which roughjs reads as "pick a random one".
function seedOf(seed: number, key: string): number {
    let hash = (seed >>> 0) ^ 0x811c9dc5;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
    return ((hash >>> 0) % (2 ** 31 - 1)) + 1;
}
