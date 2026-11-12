// The functions that work on where cells are. ROW and COLUMN look at a reference without reading it, and INDEX
// gives back a part of what it was given, so A1:INDEX(B:B,5) is a range. The lookups each search one row or one
// column of a table and pick their result at the position that search found.

import { NA, REF, VALUE } from '../values/errors';
import type { Table } from './registry';
import {
    ANYWHERE,
    areas,
    BOOLEAN,
    Find,
    fn,
    HERE,
    INTEGER,
    LAZY,
    NUMBER,
    optional,
    PART,
    PLAIN,
    REFERENCE,
    ROOM,
    rectangle,
    refusing,
    skippable,
    TABLE,
} from './registry';

type Key = number | string | boolean | null;

// VLOOKUP when `down`, else HLOOKUP: the key is searched in the first column or row, a blank key as the number 0.
function tableLookup(key: Key, table: Table, index: number, sorted: boolean, down: boolean) {
    if (index < 1) return VALUE;
    if (index > (down ? table.columns : table.rows)) return REF;
    const at = (down ? table.column(0) : table.row(0)).find(key ?? 0, sorted ? Find.AtMost : Find.Exact);
    if (at < 0) return NA;
    return down ? table.at(at, index - 1) : table.at(index - 1, at);
}

export const LOOKUP = [
    fn('ROW', [HERE, ROOM], (reference, room) =>
        room.series(reference.top + 1, reference.bottom - reference.top + 1, 1),
    ),
    fn('COLUMN', [HERE, ROOM], (reference, room) =>
        room.series(reference.left + 1, 1, reference.right - reference.left + 1),
    ),
    fn(
        'INDEX',
        [areas(TABLE), INTEGER, optional(INTEGER), optional(INTEGER, 1)],
        (source, row, column, areaNumber) => {
            if (row < 0 || (column ?? 0) < 0 || areaNumber < 1) return VALUE;
            const table = source.area(areaNumber - 1);
            if (table === undefined) return REF;
            // One index into a single row counts along it.
            const along = column === undefined && table.rows === 1;
            const r = along ? 0 : row;
            const c = along ? row : (column ?? 0);
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
        [refusing(REFERENCE, VALUE), INTEGER, INTEGER, skippable(INTEGER), skippable(INTEGER)],
        (base, down, across, height, width) => {
            const rows = height ?? base.bottom - base.top + 1;
            const columns = width ?? base.right - base.left + 1;
            if (rows === 0 || columns === 0) return REF;
            // A negative size counts back from the corner.
            const top = base.top + down + (rows < 0 ? rows + 1 : 0);
            const left = base.left + across + (columns < 0 ? columns + 1 : 0);
            return rectangle(base.sheet, top, left, top + Math.abs(rows) - 1, left + Math.abs(columns) - 1);
        },
        ANYWHERE,
    ),
    // A type of 0 is the key itself, a negative one takes the values for sorted downward.
    fn('MATCH', [PLAIN, refusing(TABLE, NA), optional(NUMBER, 1)], (key, table, type) => {
        if (table.rows > 1 && table.columns > 1) return NA;
        const values = table.columns === 1 ? table.column(0) : table.row(0);
        const at = values.find(key ?? 0, type === 0 ? Find.Exact : type < 0 ? Find.AtLeast : Find.AtMost);
        return at < 0 ? NA : at + 1;
    }),
    fn(
        'XMATCH',
        [PLAIN, refusing(TABLE, NA), optional(INTEGER, 0), skippable(INTEGER, 1)],
        (key, table, match, search) => {
            if (table.rows > 1 && table.columns > 1) return VALUE;
            const at = (table.columns === 1 ? table.column(0) : table.row(0)).seek(key, match, search);
            if (typeof at !== 'number') return at;
            return at < 0 ? NA : at + 1;
        },
    ),
    fn('VLOOKUP', [PLAIN, refusing(TABLE, NA), INTEGER, optional(BOOLEAN, true)], (key, table, column, sorted) =>
        tableLookup(key, table, column, sorted, true),
    ),
    fn('HLOOKUP', [PLAIN, refusing(TABLE, NA), INTEGER, optional(BOOLEAN, true)], (key, table, row, sorted) =>
        tableLookup(key, table, row, sorted, false),
    ),
    // The values are searched down the first column when the table is at least as high as it is wide, else along
    // the first row, and the result comes from the last column or row, or from the result range at that place.
    fn('LOOKUP', [PLAIN, refusing(TABLE, NA), optional(TABLE)], (key, table, result) => {
        const down = table.rows >= table.columns;
        const at = (down ? table.column(0) : table.row(0)).find(key ?? 0, Find.AtMost);
        if (at < 0) return NA;
        if (result === undefined) return down ? table.at(at, table.columns - 1) : table.at(table.rows - 1, at);
        return result.rows > 1 ? result.at(at, 0) : result.at(0, at);
    }),
    // The result is the row of the result range beside the value found in a column, or its column under the value
    // found in a row.
    fn(
        'XLOOKUP',
        [PLAIN, refusing(TABLE, NA), TABLE, skippable(LAZY, NA), optional(INTEGER, 0), skippable(INTEGER, 1)],
        (key, lookup, result, missing, match, search) => {
            const down = lookup.columns === 1;
            if (!down && lookup.rows > 1) return VALUE;
            if ((down ? lookup.rows : lookup.columns) !== (down ? result.rows : result.columns)) return VALUE;
            const at = (down ? lookup.column(0) : lookup.row(0)).seek(key, match, search);
            if (typeof at !== 'number') return at;
            if (at < 0) return missing;
            return down ? result.part(at, 0, 1, result.columns) : result.part(0, at, result.rows, 1);
        },
        PART,
    ),
];
