import type { EigenFont } from '../constants/fonts';
import { EIGEN_FONTS } from '../constants/fonts';
import { getFontMetrics } from '../vector/font-metrics';
import { SHEET_DEFAULT_FONT_SIZE } from './defaults';

// What a cell with no `ff` draws in, in the editor and in the xlsx export.
export const SHEET_DEFAULT_FONT: EigenFont = EIGEN_FONTS[0];

// The default font's widest digit in whole pixels at 96 dpi: an xlsx column width counts these
// (ECMA-376 Part 1 § 18.3.1.13), so the reader and the writer convert through it.
const { digitWidth, unitsPerEm } = getFontMetrics(SHEET_DEFAULT_FONT.name);
export const SHEET_DEFAULT_DIGIT_WIDTH = Math.round((digitWidth / unitsPerEm) * ((SHEET_DEFAULT_FONT_SIZE * 96) / 72));

// A cell's `ff` is an index into EIGEN_FONTS or a family name; a rich-text run edited in the cell
// stores its lowercased CSS stack. Undefined means the sheet default.
export function cellFontName(ff: number | string | undefined): string | undefined {
    if (typeof ff === 'number') return EIGEN_FONTS[ff]?.name;
    const family = ff?.split(',')[0].replace(/['"]/g, '').trim();
    if (!family) return undefined;
    return EIGEN_FONTS.find((font) => font.name.toLowerCase() === family.toLowerCase())?.name ?? family;
}
