// The comment mark, one fact for every surface that paints one: a right-angled triangle in the
// top-right corner of whatever carries a card. A sheet cell draws it on canvas, a canvas object as
// CSS borders — same size, same colour rules, so the two read as one mark.

import { EIGEN_STICKIES_INDICATOR_MAP } from './colors';

// Sheets' corner-triangle size, adopted whole: a cell's mark and an object's mark are the same glyph.
export const COMMENT_INDICATOR_SIZE = 11;

// The attention red: a comment whose card carries no colour, and sheets' invalid-value triangle.
// Hardcoded rather than a theme token — the canvas surfaces that paint it are pinned light.
export const INDICATOR_RED = '#FC6666';

// A card's own colour as its mark's colour: a stickies palette colour paints in its stronger
// indicator tone, any other colour paints as given, and a colourless card falls back to the red.
export function commentIndicatorColor(color?: string | null): string {
    if (!color) return INDICATOR_RED;
    return EIGEN_STICKIES_INDICATOR_MAP.get(color) ?? color;
}
