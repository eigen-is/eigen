// A value as an Excel number format shows it, such as 25% for 0.25 under 0%. The sheet writes every cell's display
// string through it, and a chart draws its value ticks through it when its axis carries a format, as a chart copied
// from a sheet does. It is the package's one use of numfmt, behind an entry of its own that holds no engine, so a
// document or a slide formats a tick as the sheet does.

import { format } from 'numfmt';

// The day line is Google's: day 0 is 30 December 1899, a negative number is a day before it, and 1900 has no
// 29 February as it has in Excel.
const DAYS = { leap1900: false };

// General is Excel's default-width General (1.23457E+11).
export function numberDisplay(value: number | string | boolean | null | undefined, fa = 'General'): string {
    if (typeof value === 'number' && !Number.isFinite(value)) return value.toString();
    try {
        return format(fa, value, DAYS);
    } catch {
        // numfmt throws on a malformed format, which an xlsx numFmt can carry into ct.fa.
        return format('General', value);
    }
}

// What TEXT makes of a number, and null where Excel answers #VALUE!: a format that does not parse, and a number
// too large for numfmt to write its digits out.
export function numberAsText(value: number, fa: string): string | null {
    try {
        const shown = format(fa, value, DAYS);
        return Math.abs(value) >= 1e21 && shown.includes('e+') ? null : shown;
    } catch {
        return null;
    }
}

export { isDateFormat } from 'numfmt';
