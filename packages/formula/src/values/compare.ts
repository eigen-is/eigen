// The one order of values, for the comparison operators and for everything that sorts or matches: a number is
// below a text, a text below FALSE, FALSE below TRUE. A blank takes the type of the other side. Numbers compare on
// 15 digits and text on its upper-cased form, so neither depends on the machine that runs it.

import { compare15 } from './precision';
import { compareText, textKey } from './text-order';
import type { Plain } from './value';

function rank(value: Plain): number {
    return typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2;
}

function blankLike(other: Plain): Plain {
    return typeof other === 'number' ? 0 : typeof other === 'string' ? '' : false;
}

// Below zero when `a` sorts first, zero when the two are equal. Errors are the caller's to take out first.
export function compareValues(a: Plain | null, b: Plain | null): number {
    if (a === null) {
        if (b === null) return 0;
        return compareValues(blankLike(b), b);
    }
    if (b === null) return compareValues(a, blankLike(a));
    if (typeof a === 'number' && typeof b === 'number') return compare15(a, b);
    if (typeof a === 'string' && typeof b === 'string') return a === b ? 0 : compareText(textKey(a), textKey(b));
    if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
    return rank(a) - rank(b);
}
