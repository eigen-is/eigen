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

const ZERO = 48;
const FIVE = 53;

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

// numfmt rounds by multiplying the double, which for 1.005 lies just under the half. So a decimal that ends in a 5
// is also shown a sixteenth digit higher and four lower: if only the higher text differs, the cut is at that 5.
function shown(fa: string, value: Shown): string {
    if (typeof value !== 'number') return format(fa, value, DAYS);
    // A whole number that is no multiple of 5 is its own decimal and ends in no 5.
    if (value % 5 !== 0 && Number.isInteger(value) && Math.abs(value) < 1e15) return format(fa, value, DAYS);
    const digits = value.toExponential(14);
    const decimal = Number(digits);
    const text = format(fa, decimal, DAYS);
    const first = value < 0 ? 1 : 0;
    let last = first + 15;
    while (digits.charCodeAt(last) === ZERO) last -= 1;
    if (digits.charCodeAt(last > first + 1 ? last : first) !== FIVE) return text;
    const above = Number(`${digits.slice(0, first + 16)}1${digits.slice(first + 16)}`);
    const higher = format(fa, above, DAYS);
    return higher !== text && format(fa, decimal - 4 * (above - decimal), DAYS) === text ? higher : text;
}

export { isDateFormat } from 'numfmt';
