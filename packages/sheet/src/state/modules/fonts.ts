import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';

// The font menu's list; `ff` may be stored as an index into it (cellFontName in @workspace/lib/sheets).
export const FONT_ARRAY = EIGEN_FONTS.map((font) => font.name);
