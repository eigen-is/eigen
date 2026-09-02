import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';

// Single source for the font list — engine rendering, xlsx import, and the
// toolbar/menu pickers all read this; `ff` may be stored as an index into FONT_ARRAY.
export const FONT_ARRAY = EIGEN_FONTS.map((font) => font.name);
export const FONT_INDEX_BY_NAME: Record<string, number> = Object.fromEntries(
    EIGEN_FONTS.map((font, i) => [font.name.toLowerCase(), i] as const),
);
