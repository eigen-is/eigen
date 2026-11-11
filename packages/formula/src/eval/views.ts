// Reading the cells a reference names without copying them: how large a reference is, where its first error sits,
// and the array it becomes when an operator needs its elements. A reference to a whole column or row is as long as
// its sheet is used, so it costs the cells that exist and not the grid.

import type { Column } from '../store/column';
import { CellKind, KIND_MASK } from '../store/column';
import type { Sheet } from '../store/sheet';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import type { FormulaError } from '../values/errors';
import type { ArrayValue, Reference, Scalar } from '../values/value';
import { arrayOf } from '../values/value';
import type { Evaluator } from './evaluator';

// One past the last row of a column that holds a value or a formula, and at least `floor`.
function usedEnd(column: Column, floor: number): number {
    let end = column.length;
    while (end > floor && column.kind[end - 1] === CellKind.Empty && column.shape[end - 1] === 0) end -= 1;
    return end;
}

function usedRows(sheet: Sheet): number {
    let used = 1;
    for (const column of sheet.columns) used = Math.max(used, usedEnd(column, used));
    return used;
}

function usedColumns(sheet: Sheet): number {
    let used = sheet.columns.length;
    while (used > 1 && usedEnd(sheet.columns[used - 1], 0) === 0) used -= 1;
    return Math.max(used, 1);
}

export function rowsOf(reference: Reference): number {
    const rows = reference.bottom - reference.top + 1;
    return rows === GRID_ROWS ? usedRows(reference.sheet) : rows;
}

export function columnsOf(reference: Reference): number {
    const columns = reference.right - reference.left + 1;
    return columns === GRID_COLUMNS ? usedColumns(reference.sheet) : columns;
}

// The first error of one area, row by row, once its cells are settled. A cell on a loop still carries its flags.
export function firstError(ctx: Evaluator, area: Reference): FormulaError | null {
    const { columns } = area.sheet;
    const right = Math.min(area.right, columns.length - 1);
    let found: FormulaError | null = null;
    let foundRow = GRID_ROWS;
    for (let c = area.left; c <= right; c += 1) {
        const column = columns[c];
        if (column.errors === 0) continue;
        const end = Math.min(area.bottom + 1, column.length, foundRow);
        for (let row = area.top; row < end; row += 1) {
            if ((column.kind[row] & KIND_MASK) !== CellKind.Error) continue;
            found = ctx.workbook.error(column.ref[row]);
            foundRow = row;
            break;
        }
    }
    return found;
}

// The cells of one area as an array, or the cell itself when there is one.
export function toArray(ctx: Evaluator, area: Reference): Scalar | ArrayValue {
    ctx.cells.settleArea(area);
    const rows = rowsOf(area);
    const columns = columnsOf(area);
    const items = new Array<Scalar>(rows * columns);
    for (let c = 0; c < columns; c += 1) {
        const column = area.sheet.columns[area.left + c];
        for (let r = 0; r < rows; r += 1) {
            items[r * columns + c] = column === undefined ? null : ctx.workbook.value(column, area.top + r);
        }
    }
    return arrayOf(rows, columns, items);
}
