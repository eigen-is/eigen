// A value as an Excel number format shows it, such as 25% for 0.25 under 0%. The sheet writes every cell's display
// string through it, a chart draws its value ticks through it when its axis carries a format, and TEXT answers with
// it. A number is shown as the 15 digit decimal Excel holds and not as the double under it. It is the package's one
// use of numfmt, behind an entry of its own that holds no engine, so a document or a slide formats a tick as the
// sheet does.

import { format } from 'numfmt';

type Shown = number | string | boolean | null | undefined;

// The day line is Google's: day 0 is 30 December 1899, a negative number is a day before it, and 1900 has no
// 29 February as it has in Excel.
const DAYS = { leap1900: false };

// General is Excel's default-width General (1.23457E+11).
export function numberDisplay(value: Shown, fa = 'General'): string {
    if (typeof value === 'number' && !Number.isFinite(value)) return value.toString();
    try {
        return shown(fa, value);
    } catch {
        // numfmt throws on a malformed format, which an xlsx numFmt can carry into ct.fa.
        return shown('General', value);
    }
}

// What TEXT makes of a number or a text, and null where Excel answers #VALUE!: a format that does not parse, and a
// number too large for numfmt to write its digits out.
export function valueAsText(value: number | string, fa: string): string | null {
    try {
        const text = shown(fa, value);
        return typeof value === 'number' && Math.abs(value) >= 1e21 && text.includes('e+') ? null : text;
    } catch {
        return null;
    }
}

function shown(fa: string, value: Shown): string {
    return format(fa, value, DAYS);
}

export { isDateFormat } from 'numfmt';
