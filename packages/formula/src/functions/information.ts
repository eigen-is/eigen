// The functions that ask what a value is, such as whether it is a number, an error or a reference. They take an
// error as a value, so an error in the cell they look at is theirs to answer for and does not end the call.

import { rangeToA1 } from '../text/a1';
import { quoteSheetName } from '../text/sheet-name';
import { NA, VALUE } from '../values/errors';
import { isError } from '../values/value';
import {
    ANY,
    ANYTHING,
    addin,
    apiece,
    areas,
    CORNER,
    ENGINE,
    fn,
    HERE,
    INTEGER,
    optional,
    REFERENCE,
    TEXT,
} from './registry';

// Excel's errors in the order ERROR.TYPE numbers them, from 1. The order in which a cell stores ours is another.
const EXCEL_ERRORS: readonly string[] = [
    '#NULL!',
    '#DIV/0!',
    '#VALUE!',
    '#REF!',
    '#NAME?',
    '#NUM!',
    '#N/A',
    '#GETTING_DATA',
    '#SPILL!',
    '#CONNECT!',
    '#BLOCKED!',
    '#UNKNOWN!',
    '#FIELD!',
    '#CALC!',
];

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
    fn('ISEVEN', [addin(INTEGER)], (whole) => whole % 2 === 0),
    fn('ISODD', [addin(INTEGER)], (whole) => whole % 2 !== 0),
    // The place of the error in Excel's list, and #N/A for a value that is no error or an error not in the list.
    fn('ERROR.TYPE', [ANY], (value) => {
        const place = isError(value) ? EXCEL_ERRORS.indexOf(value.text) : -1;
        return place < 0 ? NA : place + 1;
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
    fn('ISFORMULA', [apiece(areas(REFERENCE)), ENGINE], (_cell, book) => book.formula() !== null),
    // One fact about the first cell of a reference, and with none about the cell of the formula. The facts only a
    // host has, such as a format or a width, are #VALUE!, and so is a type that does not exist.
    fn('CELL', [TEXT, areas(HERE), ENGINE], (type, at, book) => {
        const sheet = book.elsewhere();
        switch (type.toLowerCase()) {
            case 'address': {
                // Of a union the first area is its first cell, and every other area is written whole.
                const first = rangeToA1({ row: [at.top, at.top], column: [at.left, at.left] }, true);
                let address = (sheet === null ? '' : `${quoteSheetName(sheet)}!`) + first;
                for (let area = at.next; area !== null; area = area.next) {
                    address += `, ${rangeToA1({ row: [area.top, area.bottom], column: [area.left, area.right] }, true)}`;
                }
                return address;
            }
            case 'col':
                return at.left + 1;
            case 'row':
                return at.top + 1;
            case 'contents':
                return book.value();
            case 'type': {
                const value = book.value();
                return value === null ? 'b' : typeof value === 'string' ? 'l' : 'v';
            }
            default:
                return VALUE;
        }
    }),
    // What INFO tells is the machine's and the program's, which only a host knows: Excel on the web answers
    // #VALUE! for every type too.
    fn('INFO', [TEXT], () => VALUE),
    // The place of a sheet among the tabs changes when a sheet comes, goes or moves, with no cell written: a row
    // that asks the workbook hears of that.
    fn('SHEET', [areas(HERE), ENGINE], (at) => at.sheet + 1),
    fn('SHEETS', [optional(areas(REFERENCE)), ENGINE], (at, book) => (at === undefined ? book.sheets() : 1)),
];
