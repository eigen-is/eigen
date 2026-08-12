import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';

// Bundled font names, derived from the canonical registry so the numeric `ff` index stays
// locked to the sheet package's locale `fontarray` (itself `EIGEN_FONTS.map(f => f.name)`): any
// cell stored with a numeric `ff` resolves through this array. Strings (post-xlsx-import or
// user-entered) are used as-is and only fall back to the bundled list when the numeric form
// is encountered.
export const FONT_ARRAY = EIGEN_FONTS.map((font) => font.name);

export function resolveFontFamily(ff: number | string | undefined): string | undefined {
    if (typeof ff === 'number') return FONT_ARRAY[ff];
    if (typeof ff === 'string' && ff.length > 0) return ff;
    return undefined;
}
