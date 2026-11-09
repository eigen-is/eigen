// Sorting a range of the sheet by one of its columns, ascending or descending: the selected range from a menu such
// as the Data menu, or the range a dialog such as Custom sort names. A header row, when the caller says the range has
// one, stays in place. As in Excel, a cell moves with its formats and its link, while borders and the ranges of rules
// stay where they are, and a formula is shifted to the row it lands on and evaluated again.

import { isEqual } from 'es-toolkit/compat';
import numeral from 'numeral';
import { createArrayResolver } from '../../engine/cell-resolver';
import { cellValue } from '../../engine/format';
import type { Cell } from '../../engine/types';
import type { Context, Selection } from '..';
import { diff, getFlowdata, isdatetime, isRealNull, isRealNum } from '..';
import { getSheet } from '../api/common';
import { landedCell } from './carry';
import { snapshotContext } from './formula-cache';
import { jfrefreshgrid } from './refresh';

// The menus' Ascending and Descending: the one selected range, by its first column.
export function sortSelection(ctx: Context, isAsc: boolean) {
    if (ctx.selections?.length !== 1) return;
    sortRange(ctx, ctx.selections[0], isAsc);
}

export function sortRange(ctx: Context, range: Selection, isAsc: boolean, columnOffset = 0, hasHeaderRow = false) {
    if (ctx.allowEdit === false) return;
    const d = getFlowdata(snapshotContext(ctx));
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

    sortDataRange(ctx, { row: [startRow, endRow], column: [startColumn, endColumn] }, columnOffset, isAsc);
}

export function sortDataRange(
    ctx: Context,
    { row, column }: Pick<Selection, 'row' | 'column'>,
    index: number,
    isAsc: boolean,
) {
    // Cells are read from a plain view, because a read through an immer draft makes a child draft of each cell.
    const snapshot = snapshotContext(ctx);
    const plain = getSheet(snapshot);
    const sheet = getSheet(ctx);
    const { data } = sheet;
    if (!plain.data || !data) return;
    const [startRow, endRow] = row;
    const [startColumn, endColumn] = column;

    const order = sortedOrder(
        isAsc,
        index,
        plain.data.slice(startRow, endRow + 1).map((cells) => cells.slice(startColumn, endColumn + 1)),
    );
    if (order.every((from, to) => from === to)) return;

    // The recompute below reaches only a formula that reads a written cell, so one reading outside the range gets its
    // value here. One reading a moved cell lands with the value of the rows as they were, and is recomputed.
    const resolver = createArrayResolver(snapshot.sheets);
    for (const [to, from] of order.entries()) {
        if (to === from) continue;
        const r = startRow + to;
        const sr = startRow + from;
        for (let c = startColumn; c <= endColumn; c += 1) {
            const cell = landedCell(ctx, plain.data[sr][c], to - from, 0, resolver);
            if (!isEqual(cell, plain.data[r][c])) data[r][c] = cell;
            const key = `${r}_${c}`;
            const link = plain.hyperlink?.[`${sr}_${c}`];
            if (link) (sheet.hyperlink ??= {})[key] = link;
            else if (plain.hyperlink?.[key]) delete sheet.hyperlink?.[key];
        }
    }

    jfrefreshgrid(ctx, [{ row, column }]);
}

// The old place of each row in its sorted order by the column at `index`, empty cells last.
export function sortedOrder(isAsc: boolean, index: number, data: readonly (Cell | null)[][]) {
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
    return data.map((_, i) => i).sort((a, b) => compare(data[a], data[b]));
}
