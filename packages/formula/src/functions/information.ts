// The functions that ask what a value is, such as whether it is a number, an error or a reference. They take an
// error as a value, so an error in the cell they look at is theirs to answer for and does not end the call.

import { CALC, NA } from '../values/errors';
import { isError } from '../values/value';
import { ANY, ANYTHING, CORNER, fn, INTEGER, strict } from './registry';

export const INFORMATION = [
    fn('ISBLANK', [ANY], (value) => value === null),
    fn('ISERROR', [ANY], isError),
    fn('ISERR', [ANY], (value) => isError(value) && value !== NA),
    fn('ISNA', [ANY], (value) => value === NA),
    fn('ISLOGICAL', [ANY], (value) => typeof value === 'boolean'),
    fn('ISNUMBER', [ANY], (value) => typeof value === 'number'),
    fn('ISREF', [ANYTHING], (whole) => whole.reference),
    fn('ISTEXT', [ANY], (value) => typeof value === 'string'),
    fn('ISNONTEXT', [ANY], (value) => typeof value !== 'string'),
    // The fraction is cut off first, so 2.9 and -2.9 are even, and a number too large to hold a unit is even.
    fn('ISEVEN', [strict(INTEGER)], (whole) => whole % 2 === 0),
    fn('ISODD', [strict(INTEGER)], (whole) => whole % 2 !== 0),
    // The place of the error in Excel's list, where #CALC! is 14, and #N/A for a value that is no error.
    fn('ERROR.TYPE', [ANY], (value) => {
        if (!isError(value)) return NA;
        if (value === CALC) return 14;
        return value.code >= 1 && value.code <= NA.code ? value.code : NA;
    }),
    // A number is itself and TRUE is 1. A text and a blank are 0, and an error stays the error it is.
    fn('N', [CORNER], (value) => (typeof value === 'number' || isError(value) ? value : value === true ? 1 : 0)),
    fn('NA', [], () => NA),
    // A text is itself and an error stays the error it is. Everything else is empty text.
    fn('T', [CORNER], (value) => (typeof value === 'string' || isError(value) ? value : '')),
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
