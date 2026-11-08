// Sorting a range of the sheet by one of its columns, ascending or descending: the selected range from a menu such
// as the Data menu, or the range a dialog such as Custom sort names. A header row, when the caller says the range has
// one, stays in place. Formulas in the sorted rows are shifted to the rows they land on and evaluated again.

import numeral from 'numeral';
import { createArrayResolver } from '../../engine/cell-resolver';
import { cellValue } from '../../engine/format';
import type { Cell, CellMatrix } from '../../engine/types';
import type { Context, Selection } from '..';
import { diff, getFlowdata, isdatetime, isRealNull, isRealNum } from '..';
import { execfunction, functionCopy, numberDisplay } from '.';
import { jfrefreshgrid } from './refresh';

// The menus' Ascending and Descending: the one selected range, by its first column.
export function sortSelection(ctx: Context, isAsc: boolean) {
    if (ctx.selections?.length !== 1) return;
    sortRange(ctx, ctx.selections[0], isAsc);
}

export function sortRange(ctx: Context, range: Selection, isAsc: boolean, columnOffset = 0, hasHeaderRow = false) {
    if (ctx.allowEdit === false) return;
    const d = getFlowdata(ctx);
    if (d == null) return;

    const {
        row: [rangeStart, rangeEnd],
        column: [startColumn, endColumn],
    } = range;

    // The sort runs from the first to the last row with a value in the range's first column.
    let startRow: number | undefined;
    let endRow: number | undefined;
    for (let r = rangeStart + (hasHeaderRow ? 1 : 0); r <= rangeEnd; r += 1) {
        const cell = d[r]?.[startColumn];
        if (cell == null || cell.mc != null || isRealNull(cellValue(cell))) continue;
        startRow ??= r;
        endRow = r;
    }
    if (startRow == null || endRow == null) return;

    const data = d.slice(startRow, endRow + 1).map((row) => row.slice(startColumn, endColumn + 1));
    // A merged cell can't move with its row, so a range that holds one stays as it is.
    if (data.some((row) => row.some((cell) => cell?.mc != null))) return;

    sortDataRange(ctx, d, data, columnOffset, isAsc, startRow, endRow, startColumn, endColumn);
}

export function sortDataRange(
    ctx: Context,
    sheetData: CellMatrix,
    dataRange: CellMatrix,
    index: number,
    isAsc: boolean,
    startRow: number,
    endRow: number,
    startColumn: number,
    endColumn: number,
) {
    const { sortedData, rowOffsets } = sortRows(isAsc, index, dataRange);

    // One live resolver serves every formula in the sort, so no formula takes its own snapshot of the workbook.
    const resolver = createArrayResolver(ctx.sheets);
    for (let r = startRow; r <= endRow; r += 1) {
        for (let c = startColumn; c <= endColumn; c += 1) {
            const cell = sortedData[r - startRow][c - startColumn];
            if (cell?.f) {
                const moveOffset = rowOffsets[r - startRow];
                let func = cell.f;
                if (moveOffset !== 0) {
                    func = `=${functionCopy(func, moveOffset, 0)}`;
                }
                const funcV = execfunction(ctx, func, r, c, { resolver });
                [, cell.v, cell.f] = funcV;
                cell.m = numberDisplay(cell.v, cell.ct?.fa);
            }
            sheetData[r][c] = cell;
        }
    }

    jfrefreshgrid(ctx, sheetData, [{ row: [startRow, endRow], column: [startColumn, endColumn] }]);
}

// The rows in their sorted order by the column at `index`, empty cells last, and how far each one moved.
export function sortRows(isAsc: boolean, index: number, data: readonly (Cell | null)[][]) {
    const ascending = (x: (Cell | null)[], y: (Cell | null)[]) => {
        const x1 = cellValue(x[index]);
        const y1 = cellValue(y[index]);
        if (isRealNull(x1)) {
            return isAsc ? 1 : -1;
        }

        if (isRealNull(y1)) {
            return isAsc ? -1 : 1;
        }
        if (isdatetime(x1) && isdatetime(y1)) {
            return diff(String(x1), String(y1));
        }
        if (isRealNum(x1) && isRealNum(y1)) {
            const y1Value = numeral(y1).value();
            const x1Value = numeral(x1).value();
            if (y1Value == null || x1Value == null) return 0;
            return x1Value - y1Value;
        }
        if (!isRealNum(x1) && !isRealNum(y1)) {
            return String(x1).localeCompare(String(y1), 'en');
        }
        if (!isRealNum(x1)) {
            return 1;
        }
        if (!isRealNum(y1)) {
            return -1;
        }
        return 0;
    };
    const descending = (x: (Cell | null)[], y: (Cell | null)[]) => ascending(y, x);
    const compare = isAsc ? ascending : descending;
    // The old place of each row in its new order, so a formula knows how far its row moved.
    const order = data.map((_, i) => i).sort((a, b) => compare(data[a], data[b]));
    return { sortedData: order.map((i) => data[i]), rowOffsets: order.map((from, to) => to - from) };
}
