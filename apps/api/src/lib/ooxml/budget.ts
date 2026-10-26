// One of an Office reader's caps for a crafted file, counted in units of work. Work the reader can't do without is
// charged, and once the charges pass the limit the whole file is refused as a 413 in the format's words. Work the
// reader may leave out, such as a chart, is spent only when what is left covers it. A reader keeps each running
// total in one, such as the parts openPackage parses or the shapes a pptx holds.

import { ApiError } from '../core/errors';

// A reader that weighs the Yjs update it emits counts a string attribute as one unit per this many characters. The
// update spells the attribute out for every node or mark that carries it, at about 3.5 bytes a character.
export const CHARS_PER_UNIT = 512;

export type Budget = {
    // Throws the 413 once the units charged pass the limit, and for an amount that is no count of work.
    charge(units: number): void;
    // Whether what is left covers this much, charging nothing.
    affords(units: number): boolean;
    // Charges this much only when what is left covers it.
    spend(units: number): boolean;
};

export function budget(limit: number, tooLarge: string): Budget {
    let left = limit;
    // NaN, an infinity or a negative amount is a reader's bug or a crafted count. Charging one spends the whole budget,
    // so it can never turn the budget off.
    const isCount = (units: number) => Number.isFinite(units) && units >= 0;
    const affords = (units: number) => isCount(units) && left >= units;
    return {
        charge: (units) => {
            left = isCount(units) ? left - units : Number.NEGATIVE_INFINITY;
            if (left < 0) throw new ApiError(413, tooLarge);
        },
        affords,
        spend: (units) => {
            if (!affords(units)) return false;
            left -= units;
            return true;
        },
    };
}
