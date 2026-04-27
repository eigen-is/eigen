// Bundled font families exposed in the sheets app. Indices match fortune-sheet's
// locale `fontarray`, so any cell stored with a numeric `ff` resolves through this
// array. Strings (post-xlsx-import or user-entered) are used as-is and only fall
// back to the bundled list when the numeric form is encountered.
export const FONT_ARRAY = ['Inter', 'Source Serif 4', 'JetBrains Mono', 'Excalifont'];

export function resolveFontFamily(ff: number | string | undefined): string | undefined {
    if (typeof ff === 'number') return FONT_ARRAY[ff];
    if (typeof ff === 'string' && ff.length > 0) return ff;
    return undefined;
}
