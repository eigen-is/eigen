// The directions an elbow arrow runs in, ported from Excalidraw. A Heading is the axis direction an arrow
// leaves a shape by. The few distances that more than one elbow module needs, such as the padding around a bound
// shape, live here too. This file imports nothing that reaches the kind registry, so a kind module, such as the
// arrow's painter, can load it first.

import type { Point } from './geometry';

// A unit orthogonal direction. Compared by value (compareHeading), never by reference.
export type Heading = { x: number; y: number };

export const HEADING_RIGHT: Heading = { x: 1, y: 0 };
export const HEADING_LEFT: Heading = { x: -1, y: 0 };
export const HEADING_DOWN: Heading = { x: 0, y: 1 };
export const HEADING_UP: Heading = { x: 0, y: -1 };

// Excalidraw's BASE_PADDING: the room an elbow arrow leaves between a bound shape and its first bend.
export const BASE_PADDING = 40;
// Excalidraw's BASE_BINDING_GAP_ELBOW, the elbow arrow's base gap to a shape's outline.
export const BASE_BINDING_GAP_ELBOW = 5;
// Excalidraw's DEDUP_TRESHOLD: two route points closer than this count as one.
export const DEDUP_THRESHOLD = 1;

// Excalidraw's vectorToHeading: snap a free vector to its dominant axis direction. The `<=` on LEFT and
// the strict `>` elsewhere are load-bearing: they decide the exit side on exact diagonals.
export function vectorToHeading(dx: number, dy: number): Heading {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (dx > ay) return HEADING_RIGHT;
    if (dx <= -ay) return HEADING_LEFT;
    if (dy > ax) return HEADING_DOWN;
    return HEADING_UP;
}

export function compareHeading(a: Heading, b: Heading): boolean {
    return a.x === b.x && a.y === b.y;
}

export function flipHeading(h: Heading): Heading {
    return { x: -h.x, y: -h.y };
}

export function headingIsHorizontal(h: Heading): boolean {
    return h.y === 0;
}

// Whether the segment from a to b is mostly horizontal, as Excalidraw's headingForPointIsHorizontal. Unlike
// vectorToHeading, it reads every exact diagonal as vertical.
export function headingIsHorizontalVec(a: Point, b: Point): boolean {
    return Math.abs(a.y - b.y) < Math.abs(a.x - b.x);
}
