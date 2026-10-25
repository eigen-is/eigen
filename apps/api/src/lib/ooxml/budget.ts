// What an Office reader may still do for a crafted file: each cap is one budget of units. Work the file can't be
// read without is charged, and past the cap the whole file is a 413 in the format's words; work that may be left
// out, a chart, asks first and is spent only when what is left covers it.

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
