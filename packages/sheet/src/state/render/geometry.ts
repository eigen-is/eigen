// Pure viewport geometry for the canvas renderer. visibledatarow/-column hold
// cumulative bottom/right edges per index; everything here is in canvas space
// (sheet coordinate minus scroll).

import { sortedIndex } from 'es-toolkit/compat';

// 1px canvas strokes land crisp only when centered on a half-pixel; every
// grid/border line shifts by this amount (inherited fortune-sheet convention,
// formerly the `bodrder05` parameter threaded through every render call).
export const HALF_PIXEL = 0.5;

// Cell fill rect adjustment relative to the raw cell edges
// (left/top/width/height) — same inherited fudge family as HALF_PIXEL;
// preserve the exact values.
export const BORDER_FIX = [-1, 0, 0, -1] as const;

// Index range of cells touching the viewport, shifted by the freeze-region
// cell offset; end clamps to the last index.
export function mainVisibleRange(
    positions: number[],
    scrollPos: number,
    drawSize: number,
    offsetCell: number,
): { start: number; end: number } {
    const start = sortedIndex(positions, scrollPos) + offsetCell;
    let end = sortedIndex(positions, scrollPos + drawSize) + offsetCell;
    if (end >= positions.length) {
        end = positions.length - 1;
    }
    return { start, end };
}

// Header variant: no freeze offset, and the inherited behavior keeps end at
// positions.length when the viewport extends past the last entry (the loop's
// final iteration reads an undefined edge and draws nothing).
export function headerVisibleRange(
    positions: number[],
    scrollPos: number,
    drawSize: number,
): { start: number; end: number } {
    return {
        start: sortedIndex(positions, scrollPos),
        end: sortedIndex(positions, scrollPos + drawSize),
    };
}

export function colStartX(visibledatacolumn: number[], c: number, scrollWidth: number): number {
    return c === 0 ? -scrollWidth : visibledatacolumn[c - 1] - scrollWidth;
}

export function colEndX(visibledatacolumn: number[], c: number, scrollWidth: number): number {
    return visibledatacolumn[c] - scrollWidth;
}

// Row edges start one pixel above the column grid (inherited convention from
// the same fudge family as HALF_PIXEL — preserve the exact values).
export function rowStartY(visibledatarow: number[], r: number, scrollHeight: number): number {
    return r === 0 ? -scrollHeight - 1 : visibledatarow[r - 1] - scrollHeight - 1;
}

export function rowEndY(visibledatarow: number[], r: number, scrollHeight: number): number {
    return visibledatarow[r] - scrollHeight;
}
