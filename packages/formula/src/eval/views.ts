// Reading the cells a reference names: where its first error sits, and the array it becomes when an operator needs
// its elements. The array stores one row for every row of the area that holds a cell and one for every stretch of
// rows that hold none, and its columns the same way, so a reference costs the cells that exist, wherever they lie.

import { CellKind, KIND_MASK } from '../store/column';
import { GRID_ROWS } from '../text/a1';
import type { FormulaError } from '../values/errors';
import { CALC } from '../values/errors';
import type { ArrayValue, Reference, Scalar } from '../values/value';
import { arrayOf } from '../values/value';
import type { Evaluator } from './evaluator';

// The first error of one area, row by row, once its cells are settled. A cell on a loop still carries its flags.
export function firstError(ctx: Evaluator, area: Reference): FormulaError | null {
    const { columns } = ctx.workbook.sheets[area.sheet];
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
    ctx.recalc.settleArea(area);
    const { top, left } = area;
    const sheet = ctx.workbook.sheets[area.sheet].columns;
    const rows = area.bottom - top + 1;
    const columns = area.right - left + 1;
    const across = Math.max(0, Math.min(columns, sheet.length - left));
    let down = 0;
    for (let c = 0; c < across; c += 1) down = Math.max(down, Math.min(rows, sheet[left + c].length - top));
    // Which rows and columns of the area hold a cell. Only this decides what is stored, never how long a column is.
    const filledRows = ctx.marks(down, true);
    const filledColumns = ctx.marks(across, false);
    for (let c = 0; c < across; c += 1) {
        const { kind, length } = sheet[left + c];
        const end = Math.min(rows, length - top);
        for (let r = 0; r < end; r += 1) {
            if ((kind[top + r] & KIND_MASK) === CellKind.Empty) continue;
            filledRows[r] = 1;
            filledColumns[c] = 1;
        }
    }
    const rowEnds = runs(filledRows, down, rows);
    const columnEnds = runs(filledColumns, across, columns);
    const height = rowEnds?.length ?? rows;
    const width = columnEnds?.length ?? columns;
    if (!ctx.recalc.room(height * width)) return CALC;
    // Filled with blanks one by one and never made at its size: an array made ten thousand long or longer throws
    // the engine that runs this out of its compiled code, for every reference read after it too.
    const items: Scalar[] = [];
    for (let at = height * width; at > 0; at -= 1) items.push(null);
    for (let j = 0; j < width; j += 1) {
        const c = columnEnds === null || j === 0 ? j : columnEnds[j - 1];
        const column = c < across && filledColumns[c] === 1 ? sheet[left + c] : null;
        for (let i = 0; i < height; i += 1) {
            const r = rowEnds === null || i === 0 ? i : rowEnds[i - 1];
            const held = column !== null && r < down && filledRows[r] === 1;
            items[i * width + j] = held ? ctx.workbook.value(column, top + r) : null;
        }
    }
    return arrayOf(rows, columns, items, rowEnds, columnEnds);
}

// Where the runs of an axis of `size` end: each of the first `length` marks that is set is a run of its own, and
// each stretch of the others, the axis past the marks included, is one. Null when every run is one long.
function runs(filled: Uint8Array, length: number, size: number): Int32Array | null {
    let count = length < size && (length === 0 || filled[length - 1] === 1) ? 1 : 0;
    for (let at = 0; at < length; at += 1) if (filled[at] === 1 || at === 0 || filled[at - 1] === 1) count += 1;
    if (count === size) return null;
    const ends = new Int32Array(count);
    let run = -1;
    for (let at = 0; at < length; at += 1) {
        if (filled[at] === 1 || at === 0 || filled[at - 1] === 1) run += 1;
        ends[run] = at + 1;
    }
    ends[count - 1] = size;
    return ends;
}
