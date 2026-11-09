// Sorting a range of the sheet by one of its columns, ascending or descending: the selected range from a menu such
// as the Data menu, or the range a dialog such as Custom sort names. A header row, when the caller says the range has
// one, stays in place, and so does a hidden row. As in Excel, a cell moves with its formats and its link, while borders
// and the ranges of rules stay where they are, and a formula is shifted to the row it lands on and computed there.

import { cloneDeep, isEqual } from 'es-toolkit/compat';
import numeral from 'numeral';
import { cellValue } from '../../engine/format';
import { functionCopy } from '../../engine/formula-shift';
import type { Cell } from '../../engine/types';
import type { Context, Selection } from '..';
import { diff, getFlowdata, isdatetime, isRealNull, isRealNum } from '..';
import { getSheet } from '../api/common';
import type { FormulaCell } from '../types';
import { snapshotContext } from './formula-cache';
import { recomputeCells } from './refresh';

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
    const plain = getSheet(snapshotContext(ctx));
    const { data } = getSheet(ctx);
    const before = plain.data;
    if (!before || !data) return;
    const [startColumn, endColumn] = column;

    // A row stays hidden by its index, so a row moved into a hidden one would vanish and the row moved out would show.
    const rowhidden = plain.config?.rowhidden ?? {};
    const rows = Array.from({ length: row[1] - row[0] + 1 }, (_, i) => row[0] + i).filter((r) => !(r in rowhidden));
    const order = sortedOrder(
        isAsc,
        index,
        rows.map((r) => before[r].slice(startColumn, endColumn + 1)),
    );
    if (order.every((from, to) => from === to)) return;

    // A formula lands with what it holds, on a copy because the recompute writes into its format. Its own text decides
    // from there, so a function this build lacks keeps its number, error or empty text.
    const landed: FormulaCell[] = [];
    for (const [to, from] of order.entries()) {
        if (to === from) continue;
        const r = rows[to];
        const sr = rows[from];
        for (let c = startColumn; c <= endColumn; c += 1) {
            const source = before[sr][c];
            const cell =
                source?.f == null ? source : { ...cloneDeep(source), f: `=${functionCopy(source.f, r - sr, 0)}` };
            if (isEqual(cell, before[r][c])) continue;
            data[r][c] = cell;
            landed.push({ r, c, id: ctx.currentSheetId });
        }
    }

    recomputeCells(ctx, landed, landed);
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
