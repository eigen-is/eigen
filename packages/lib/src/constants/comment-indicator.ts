// The corner triangle, one fact for every surface that paints one: a sheet cell draws it on canvas
// (a comment top-right, an invalid value or a forced string top-left), a canvas object as CSS
// borders. One size for all of them, so they read as one family of marks.

import { indicatorColor } from './colors';

export const CELL_INDICATOR_SIZE = 11;

// The attention red: a comment whose card carries no color, and sheets' invalid-value triangle.
// Hardcoded rather than a theme token — the canvas surfaces that paint it are pinned light.
export const INDICATOR_RED = '#FC6666';

// A card's own color as its mark's color, in its indicator tone. A colorless card falls back to the red.
export function commentIndicatorColor(color?: string | null): string {
    return color ? indicatorColor(color) : INDICATOR_RED;
}
