// A value as an Excel number format shows it, such as 25% for 0.25 under 0%. The sheet writes every cell's display
// string through it, and a chart draws its value ticks through it when its axis carries a format, as a chart copied
// from a sheet does. It lives here, below the sheet, so a document or a slide formats a tick as the sheet does.

import { format } from 'numfmt';
import type { Cell } from '../sheets/types';

// General is Excel's default-width General (1.23457E+11).
export function numberDisplay(value: Cell['v'] | null, fa = 'General'): string {
    if (typeof value === 'number' && !Number.isFinite(value)) return value.toString();
    try {
        return format(fa, value);
    } catch {
        // numfmt throws on a malformed format, which an xlsx numFmt can carry into ct.fa.
        return format('General', value);
    }
}
