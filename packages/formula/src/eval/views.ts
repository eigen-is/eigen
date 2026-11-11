// Reading the cells a reference names: where its first error sits, and the array it becomes when an operator needs
// its elements. A reference to a whole column or row costs the cells that exist and not the grid.

import { CellKind, KIND_MASK } from '../store/column';
import { GRID_ROWS } from '../text/a1';
import type { FormulaError } from '../values/errors';
import type { ArrayValue, Reference, Scalar } from '../values/value';
import { arrayOf } from '../values/value';
import type { Evaluator } from './evaluator';

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

// How many columns and rows of an area are stored when it is read as an array: the ones the sheet holds cells in
// and one more, which is blank and stands for the rest of the area.
export function storedColumns(area: Reference): number {
    return Math.min(area.right - area.left + 1, Math.max(0, area.sheet.columns.length - area.left) + 1);
}

export function storedRows(area: Reference, width: number): number {
    let used = 0;
    for (let c = 0; c < width; c += 1) {
        used = Math.max(used, (area.sheet.columns[area.left + c]?.length ?? 0) - area.top);
    }
    return Math.min(area.bottom - area.top + 1, used + 1);
}

// The cells of one area as an array, or the cell itself when there is one.
export function toArray(ctx: Evaluator, area: Reference): Scalar | ArrayValue {
    ctx.cells.settleArea(area);
    const width = storedColumns(area);
    const height = storedRows(area, width);
    ctx.cells.count(height * width);
    const items = new Array<Scalar>(height * width);
    for (let c = 0; c < width; c += 1) {
        const column = area.sheet.columns[area.left + c];
        for (let r = 0; r < height; r += 1) {
            items[r * width + c] = column === undefined ? null : ctx.workbook.value(column, area.top + r);
        }
    }
    return arrayOf(area.bottom - area.top + 1, area.right - area.left + 1, items, height, width);
}
