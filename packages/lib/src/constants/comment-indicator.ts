// The corner triangle, one fact for every surface that paints one: a sheet cell draws it on canvas
// (a comment top-right, an invalid value or a forced string top-left), a canvas object as CSS
// borders. One size for all of them, so they read as one family of marks.

import { EIGEN_STICKIES_INDICATOR_MAP } from './colors';

export const CELL_INDICATOR_SIZE = 11;

// The attention red: a comment whose card carries no colour, and sheets' invalid-value triangle.
// Hardcoded rather than a theme token — the canvas surfaces that paint it are pinned light.
export const INDICATOR_RED = '#FC6666';

// A card's own colour as its mark's colour: a stickies palette colour paints in its stronger
// indicator tone, any other colour paints as given, and a colourless card falls back to the red.
export function commentIndicatorColor(color?: string | null): string {
    if (!color) return INDICATOR_RED;
    return EIGEN_STICKIES_INDICATOR_MAP.get(color) ?? color;
}
