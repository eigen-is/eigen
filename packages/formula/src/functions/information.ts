// The functions that ask what a value is. They take an error as a value, so an error in the cell they look at is
// an answer and not a result.

import { NA } from '../values/errors';
import { isError } from '../values/value';
import { ANY, ANYTHING, fn } from './registry';

export const INFORMATION = [
    fn('ISBLANK', [ANY], (value) => value === null),
    fn('ISERROR', [ANY], isError),
    fn('ISNUMBER', [ANY], (value) => typeof value === 'number'),
    fn('ISREF', [ANYTHING], (whole) => whole.reference),
    fn('ISTEXT', [ANY], (value) => typeof value === 'string'),
    fn('NA', [], () => NA),
    // 1 for a number or a blank, 2 for a text, 4 for a boolean, 16 for an error and 64 for more than one value.
    fn('TYPE', [ANYTHING], (whole) => {
        if (whole.rows > 1 || whole.columns > 1) return 64;
        const value = whole.at(0, 0);
        if (isError(value)) return 16;
        return typeof value === 'string' ? 2 : typeof value === 'boolean' ? 4 : 1;
    }),
];
