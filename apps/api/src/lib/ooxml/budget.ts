// One of an Office reader's caps for a crafted file, counted in units of work. Work the reader can't do without is
// charged, and once the charges pass the limit the whole file is refused as a 413 in the format's words. Work the
// reader may leave out, such as a chart, is spent only when what is left covers it. A reader keeps each running
// total in one, such as the parts openPackage parses or the shapes a pptx holds.

import { ApiError } from '../core/errors';

export type Budget = {
    // Throws the 413 once the units charged pass the limit.
    charge(units: number): void;
    // Whether what is left covers this much, charging nothing.
    affords(units: number): boolean;
    // Charges this much only when what is left covers it.
    spend(units: number): boolean;
};

export function budget(limit: number, tooLarge: string): Budget {
    let left = limit;
    const affords = (units: number) => left >= units;
    return {
        charge: (units) => {
            left -= units;
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
