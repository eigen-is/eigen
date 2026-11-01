// Moves a sheet's filter with a row or column insert or delete: the filtered range, the column each filter entry
// sits on and the rows each entry hides. The engine moves the cells but leaves the filter alone, so the editor's
// row and column ops, such as insertRowCol, call this once the engine is done.

import type { SingleRange } from '@workspace/lib/sheets';
import { isEmpty } from 'es-toolkit/compat';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import {
    shiftKeyedMapForDelete,
    shiftKeyedMapForInsert,
    shiftRangeForDelete,
    shiftRangeForInsert,
} from '../../engine/rowcol';
import type { FilterEntry, Sheet } from '../types';

export function shiftFilterForInsert(sheet: Sheet, op: InsertRowColOp) {
    const { filterRange, filter } = sheet;
    if (!filterRange || isEmpty(filterRange)) return;
    const { type, index, count, direction } = op;
    const range = shiftRangeForInsert(filterRange, op);
    const [firstRow, lastRow] = range.row;
    const [firstColumn, lastColumn] = range.column;
    let shifted: Record<string, FilterEntry> | undefined;
    if (filter) {
        shifted = {};
        const insertAt = direction === 'lefttop' ? index : index + 1;
        for (const [key, entry] of Object.entries(filter)) {
            if (type === 'row') {
                const rowhidden = shiftKeyedMapForInsert(entry.rowhidden, index, count, direction);
                shifted[key] = { ...entry, rowhidden, str: firstRow, edr: lastRow };
            } else {
                const cindex = entry.cindex >= insertAt ? entry.cindex + count : entry.cindex;
                shifted[cindex - firstColumn] = { ...entry, cindex, stc: firstColumn, edc: lastColumn };
            }
        }
    }
    writeFilter(sheet, range, shifted);
}

export function shiftFilterForDelete(sheet: Sheet, op: DeleteRowColOp) {
    const { filterRange, filter } = sheet;
    if (!filterRange || isEmpty(filterRange)) return;
    const { type, start, end } = op;
    const deletesHeader = type === 'row' && filterRange.row[0] >= start && filterRange.row[0] <= end;
    const range = deletesHeader ? null : shiftRangeForDelete(filterRange, op);
    if (!range) {
        writeFilter(sheet, undefined, undefined);
        return;
    }
    const [firstRow, lastRow] = range.row;
    const [firstColumn, lastColumn] = range.column;
    const shifted: Record<string, FilterEntry> = {};
    for (const [key, entry] of Object.entries(filter ?? {})) {
        if (type === 'row') {
            const rowhidden = shiftKeyedMapForDelete(entry.rowhidden, start, end);
            if (!isEmpty(rowhidden)) shifted[key] = { ...entry, rowhidden, str: firstRow, edr: lastRow };
        } else if (entry.cindex < start) {
            shifted[entry.cindex - firstColumn] = { ...entry, edc: lastColumn };
        } else if (entry.cindex > end) {
            const cindex = entry.cindex - (end - start + 1);
            shifted[cindex - firstColumn] = { ...entry, cindex, stc: firstColumn, edc: lastColumn };
        }
    }
    writeFilter(sheet, range, isEmpty(shifted) ? undefined : shifted);
}

function writeFilter(sheet: Sheet, range: SingleRange | undefined, filter: Record<string, FilterEntry> | undefined) {
    sheet.filterRange = range;
    sheet.filter = filter;
    if (!filter || !sheet.config) return;
    const rowhidden = (sheet.config.rowhidden ??= {});
    for (const entry of Object.values(filter)) {
        for (const row of Object.keys(entry.rowhidden)) rowhidden[row] = 0;
    }
}
