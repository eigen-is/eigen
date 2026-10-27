// The fonts of a spreadsheet: the one a cell with no font draws in, the default digit width that column
// widths count in an xlsx, and the font name and size a cell's `ff` and `fs` stand for. Code that needs a
// cell's font, such as the cell editor and the xlsx export, reads it here, so they agree on it.

import type { EigenFont } from '../constants/fonts';
import { EIGEN_FONTS, readFontSize } from '../constants/fonts';
import { getFontMetrics } from '../vector/font-metrics';
import { SHEET_DEFAULT_FONT_SIZE } from './defaults';

// What a cell with no `ff` draws in, in the editor and in the xlsx export.
export const SHEET_DEFAULT_FONT: EigenFont = EIGEN_FONTS[0];

// The default font's widest digit in whole pixels at 96 dpi: an xlsx column width counts these
// (ECMA-376 Part 1 § 18.3.1.13), so the reader and the writer convert through it.
const { digitWidth, unitsPerEm } = getFontMetrics(SHEET_DEFAULT_FONT.name);
export const SHEET_DEFAULT_DIGIT_WIDTH = Math.round((digitWidth / unitsPerEm) * ((SHEET_DEFAULT_FONT_SIZE * 96) / 72));

// A cell's `ff` is an index into EIGEN_FONTS or a family name. A rich-text run may hold a CSS stack,
// such as one an older editor commit stored. Undefined means the sheet default.
export function cellFontName(ff: number | string | undefined): string | undefined {
    if (typeof ff === 'number') return EIGEN_FONTS[ff]?.name;
    const family = ff?.split(',')[0].replace(/['"]/g, '').trim();
    if (!family) return undefined;
    return EIGEN_FONTS.find((font) => font.name.toLowerCase() === family.toLowerCase())?.name ?? family;
}

// A cell's or a run's `fs` in pt. A collaborator or an older editor may have stored it as a string, which reads as
// its number, and a value that is no size is the sheet default.
export function cellFontSize(fs: unknown): number {
    return readFontSize(Number(fs) || undefined) ?? SHEET_DEFAULT_FONT_SIZE;
}
