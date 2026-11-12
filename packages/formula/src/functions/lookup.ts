// The functions that work on where cells are. ROW and COLUMN look at a reference without reading it, and INDEX
// gives back a part of what it was given, so A1:INDEX(B:B,5) is a range. The lookups each search one row or one
// column of a table and pick their result at the position that search found.

import { columnLabel, GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { quoteSheetName } from '../text/sheet-name';
import { NA, REF, VALUE } from '../values/errors';
import { rectangle } from '../values/rectangle';
import type { Reference } from '../values/value';
import type { Table } from './registry';
import {
    ANYWHERE,
    apiece,
    areas,
    BOOLEAN,
    defaulted,
    ENGINE,
    Find,
    fn,
    HERE,
    INTEGER,
    LAZY,
    NEARLY,
    NUMBER,
    optional,
    PART,
    PLAIN,
    placed,
    REFERENCE,
    ROOM,
    refusing,
    skippable,
    TABLE,
    TEXT,
} from './registry';

type Key = number | string | boolean | null;

// VLOOKUP when `down`, else HLOOKUP: the key is searched in the first column or row, a blank key as the number 0.
// A key that is not found is #N/A whatever column or row was asked for, one below 1 or one the table lacks.
function tableLookup(key: Key, table: Table, index: number, sorted: boolean, down: boolean) {
    const at = (down ? table.column(0) : table.row(0)).find(key ?? 0, sorted ? Find.AtMost : Find.Exact);
    if (at < 0) return NA;
    if (index < 1) return VALUE;
    if (index > (down ? table.columns : table.rows)) return REF;
    return down ? table.at(at, index - 1) : table.at(index - 1, at);
}

export const LOOKUP = [
    fn('ROW', [HERE, ROOM], (reference, room) =>
        room.series(reference.top + 1, reference.bottom - reference.top + 1, 1),
    ),
    fn('COLUMN', [HERE, ROOM], (reference, room) =>
        room.series(reference.left + 1, 1, reference.right - reference.left + 1),
    ),
    fn('ROWS', [refusing(TABLE, REF)], (table) => table.rows),
    fn('COLUMNS', [refusing(TABLE, REF)], (table) => table.columns),
    fn('AREAS', [areas(REFERENCE)], (reference) => {
        let count = 0;
        for (let area: Reference | null = reference; area !== null; area = area.next) count += 1;
        return count;
    }),
    // The kind says which of the row and the column is fixed: both, the row, the column, neither. A sheet name
    // is quoted as a formula would spell it, and an empty text for one leaves the bare mark.
    fn(
        'ADDRESS',
        [INTEGER, INTEGER, skippable(INTEGER, 1), skippable(BOOLEAN, true), skippable(TEXT)],
        (row, column, kind, a1, sheet) => {
            if (row < 1 || row > GRID_ROWS || column < 1 || column > GRID_COLUMNS || kind < 1 || kind > 4) return VALUE;
            const fixedRow = kind < 3;
            const fixedColumn = kind % 2 === 1;
            const cell = a1
                ? `${fixedColumn ? '$' : ''}${columnLabel(column - 1)}${fixedRow ? '$' : ''}${row}`
                : `R${fixedRow ? row : `[${row}]`}C${fixedColumn ? column : `[${column}]`}`;
            return sheet === undefined ? cell : `${sheet === '' ? '' : quoteSheetName(sheet)}!${cell}`;
        },
    ),
    fn(
        'INDEX',
        [defaulted(areas(TABLE), VALUE), NEARLY, optional(NEARLY), optional(INTEGER, 1)],
        (source, row, column, areaNumber) => {
            // The sign of an index is taken before its fraction is cut off: -0.5 is no index, 0.5 is 0.
            if (row < 0 || (column ?? 0) < 0 || areaNumber < 1) return VALUE;
            const table = source.area(areaNumber - 1);
            if (table === undefined) return REF;
            // One index counts along a single row or column, and gives a row of an array, but a range of several
            // rows and columns refuses it.
            if (column === undefined && source.reference && table.rows > 1 && table.columns > 1) return REF;
            const along = column === undefined && table.rows === 1;
            const r = along ? 0 : Math.trunc(row);
            const c = Math.trunc(along ? row : (column ?? 0));
            if (r > table.rows || c > table.columns) return REF;
            return table.part(
                r === 0 ? 0 : r - 1,
                c === 0 ? 0 : c - 1,
                r === 0 ? table.rows : 1,
                c === 0 ? table.columns : 1,
            );
        },
        PART,
    ),
    fn(
        'OFFSET',
        [refusing(REFERENCE, VALUE), INTEGER, INTEGER, skippable(NUMBER), skippable(NUMBER)],
        (base, down, across, height, width) => {
            if (height === 0 || width === 0) return REF;
            // A size counts from the corner, back from it when negative, and is cut toward zero only after its
            // sign is taken: half a row is the corner's row and the one before it.
            const top = base.top + down;
            const left = base.left + across;
            const end = height === undefined ? base.bottom + down : top + Math.trunc(height) - Math.sign(height);
            const side = width === undefined ? base.right + across : left + Math.trunc(width) - Math.sign(width);
            return rectangle(
                base.sheet,
                Math.min(top, end),
                Math.min(left, side),
                Math.max(top, end),
                Math.max(left, side),
            );
        },
        ANYWHERE,
    ),
    // A type of 0 is the key itself, a negative one takes the values for sorted downward.
    fn('MATCH', [PLAIN, placed(refusing(TABLE, NA)), optional(NUMBER, 1)], (key, table, type) => {
        if (table.rows > 1 && table.columns > 1) return NA;
        const values = table.columns === 1 ? table.column(0) : table.row(0);
        const at = values.find(key ?? 0, type === 0 ? Find.Exact : type < 0 ? Find.AtLeast : Find.AtMost);
        return at < 0 ? NA : at + 1;
    }),
    fn(
        'XMATCH',
        [PLAIN, defaulted(refusing(TABLE, NA), VALUE), optional(NUMBER, 0), skippable(NUMBER, 1)],
        (key, table, match, search) => {
            if (table.rows > 1 && table.columns > 1) return VALUE;
            const values = table.columns === 1 ? table.column(0) : table.row(0);
            // Both modes are cut down, not toward zero: a match mode of -0.5 is -1, a search mode of -2.5 is none.
            const at = values.seek(key, Math.floor(match), Math.floor(search));
            if (typeof at !== 'number') return at;
            return at < 0 ? NA : at + 1;
        },
    ),
    fn(
        'VLOOKUP',
        [PLAIN, placed(refusing(TABLE, NA)), INTEGER, optional(BOOLEAN, true)],
        (key, table, column, sorted) => tableLookup(key, table, column, sorted, true),
    ),
    fn('HLOOKUP', [PLAIN, placed(refusing(TABLE, NA)), INTEGER, optional(BOOLEAN, true)], (key, table, row, sorted) =>
        tableLookup(key, table, row, sorted, false),
    ),
    // Searched down the first column when the table is at least as high as it is wide, else along the first row.
    // The result comes from the last column or row, or from the result range, which is one row or one column.
    fn(
        'LOOKUP',
        [PLAIN, defaulted(refusing(TABLE, NA), VALUE), optional(refusing(TABLE, NA))],
        (key, table, result) => {
            if (result !== undefined && result.rows > 1 && result.columns > 1) return NA;
            const down = table.rows >= table.columns;
            const at = (down ? table.column(0) : table.row(0)).find(key ?? 0, Find.AtMost);
            if (at < 0) return NA;
            if (result === undefined) return down ? table.at(at, table.columns - 1) : table.at(table.rows - 1, at);
            return result.rows > 1 ? result.at(at, 0) : result.at(0, at);
        },
    ),
    // The result is the row of the result range beside the value found in a column, or its column under the value
    // found in a row. One cell to search is a column beside a result of one row, and a row above any other.
    fn(
        'XLOOKUP',
        [
            PLAIN,
            defaulted(refusing(TABLE, NA), VALUE),
            defaulted(refusing(TABLE, NA), VALUE),
            skippable(LAZY, NA),
            optional(NUMBER, 0),
            skippable(NUMBER, 1),
        ],
        (key, lookup, result, missing, match, search) => {
            const down = lookup.columns === 1 && (lookup.rows > 1 || result.rows === 1);
            if (!down && lookup.rows > 1) return VALUE;
            if ((down ? lookup.rows : lookup.columns) !== (down ? result.rows : result.columns)) return VALUE;
            const at = (down ? lookup.column(0) : lookup.row(0)).seek(key, Math.floor(match), Math.floor(search));
            if (typeof at !== 'number') return at;
            if (at < 0) return missing;
            return down ? result.part(at, 0, 1, result.columns) : result.part(0, at, result.rows, 1);
        },
        PART,
    ),
    fn('HYPERLINK', [TEXT, optional(PLAIN)], (link, name) => (name === undefined ? link : (name ?? 0))),
    fn('FORMULATEXT', [apiece(areas(REFERENCE)), ENGINE], (_cell, book) => book.formula() ?? NA),
    fn('INDIRECT', [TEXT, optional(BOOLEAN, true), ENGINE], (text, a1, book) => book.refer(text, a1), ANYWHERE),
];
