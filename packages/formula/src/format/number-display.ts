// A value as an Excel number format shows it, such as 25% for 0.25 under 0%. The sheet writes every cell's display
// string through it, and a chart draws its value ticks through it when its axis carries a format, as a chart copied
// from a sheet does. It is the package's one use of numfmt, behind an entry of its own that holds no engine, so a
// document or a slide formats a tick as the sheet does.

import { format } from 'numfmt';

// 31 December 9999.
const LAST_DATE = 2958465;

// General is Excel's default-width General (1.23457E+11).
export function numberDisplay(value: number | string | boolean | null | undefined, fa = 'General'): string {
    if (typeof value === 'number' && !Number.isFinite(value)) return value.toString();
    try {
        return format(fa, value);
    } catch {
        // numfmt throws on a malformed format, which an xlsx numFmt can carry into ct.fa.
        return format('General', value);
    }
}

// What TEXT makes of a number, and null where Excel answers #VALUE!: a format that does not parse, a date format
// on a number that is no date of Excel's, and a number too large for numfmt to write its digits out.
export function numberAsText(value: number, fa: string): string | null {
    try {
        const shown = format(fa, value);
        // Told to keep to Excel's dates, numfmt writes a number outside them plainly: where that changes the answer,
        // the format asked for a date.
        const dated = value < 0 || value >= LAST_DATE + 1;
        if (dated && shown !== format(fa, value, { dateSpanLarge: false })) return null;
        return Math.abs(value) >= 1e21 && shown.includes('e+') ? null : shown;
    } catch {
        return null;
    }
}

export { isDateFormat } from 'numfmt';
