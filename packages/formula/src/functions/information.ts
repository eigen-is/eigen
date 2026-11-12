// The functions that ask what a value is, such as whether it is a number, an error or a reference. They take an
// error as a value, so an error in the cell they look at is theirs to answer for and does not end the call.

import { NA } from '../values/errors';
import { isError } from '../values/value';
import { ANY, ANYTHING, CORNER, fn } from './registry';

export const INFORMATION = [
    fn('ISBLANK', [ANY], (value) => value === null),
    fn('ISERROR', [ANY], isError),
    fn('ISNUMBER', [ANY], (value) => typeof value === 'number'),
    fn('ISREF', [ANYTHING], (whole) => whole.reference),
    fn('ISTEXT', [ANY], (value) => typeof value === 'string'),
    // A number is itself and TRUE is 1. A text and a blank are 0, and an error stays the error it is.
    fn('N', [CORNER], (value) => (typeof value === 'number' || isError(value) ? value : value === true ? 1 : 0)),
    fn('NA', [], () => NA),
    // 1 for a number or a blank, 2 for a text, 4 for a boolean, 16 for an error, as a union is one, and 64 for
    // more than one value.
    fn('TYPE', [ANYTHING], (whole) => {
        if (whole.areas > 1) return 16;
        if (whole.rows > 1 || whole.columns > 1) return 64;
        const value = whole.at(0, 0);
        if (isError(value)) return 16;
        return typeof value === 'string' ? 2 : typeof value === 'boolean' ? 4 : 1;
    }),
];
