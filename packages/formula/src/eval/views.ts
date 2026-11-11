// Reading the cells a reference names as the array an operator needs. The array stores one row for every row of
// the area that holds a cell and one for every stretch of rows that hold none, and its columns the same way, so a
// reference to a whole column or to the whole sheet costs the cells that exist, wherever they lie.

import { CellKind, KIND_MASK } from '../store/column';
import { CALC } from '../values/errors';
import type { ArrayValue, Reference, Scalar } from '../values/value';
import { arrayOf, MOST_ELEMENTS } from '../values/value';
import type { Evaluator } from './evaluator';

// The cells of one area as an array, or the cell itself when there is one.
export function toArray(ctx: Evaluator, area: Reference): Scalar | ArrayValue {
    ctx.recalc.settleArea(area);
    const { top, left } = area;
    const sheet = area.sheet.columns;
    const rows = area.bottom - top + 1;
    const columns = area.right - left + 1;
    const across = Math.max(0, Math.min(columns, sheet.length - left));
    let down = 0;
    for (let c = 0; c < across; c += 1) down = Math.max(down, Math.min(rows, sheet[left + c].length - top));
    // Which rows and columns of the area hold a cell. Only this decides what is stored, never how long a column is.
    const filledRows = new Uint8Array(down);
    const filledColumns = new Uint8Array(across);
    for (let c = 0; c < across; c += 1) {
        const { kind, length } = sheet[left + c];
        const end = Math.min(rows, length - top);
        for (let r = 0; r < end; r += 1) {
            if ((kind[top + r] & KIND_MASK) === CellKind.Empty) continue;
            filledRows[r] = 1;
            filledColumns[c] = 1;
        }
    }
    const rowEnds = runs(filledRows, rows);
    const columnEnds = runs(filledColumns, columns);
    const height = rowEnds?.length ?? rows;
    const width = columnEnds?.length ?? columns;
    if (!ctx.recalc.room(height * width, MOST_ELEMENTS)) return CALC;
    const items = new Array<Scalar>(height * width).fill(null);
    for (let j = 0; j < width; j += 1) {
        const c = columnEnds === null || j === 0 ? j : columnEnds[j - 1];
        if (c >= across || filledColumns[c] === 0) continue;
        const column = sheet[left + c];
        for (let i = 0; i < height; i += 1) {
            const r = rowEnds === null || i === 0 ? i : rowEnds[i - 1];
            if (r < down && filledRows[r] === 1) items[i * width + j] = ctx.workbook.value(column, top + r);
        }
    }
    return arrayOf(rows, columns, items, rowEnds, columnEnds);
}

// Where the runs of an axis of `size` end: a row or column that holds a cell is a run of its own, and a stretch
// that holds none is one run, the part of the axis past `filled` included. Null when every run is one long.
function runs(filled: Uint8Array, size: number): Int32Array | null {
    const ends = new Int32Array(filled.length + 1);
    let count = 0;
    for (let at = 0; at < filled.length; at += 1) {
        if (filled[at] === 1 || at === 0 || filled[at - 1] === 1) count += 1;
        ends[count - 1] = at + 1;
    }
    if (filled.length < size && (count === 0 || filled[filled.length - 1] === 1)) count += 1;
    ends[count - 1] = size;
    return count === size ? null : ends.subarray(0, count);
}
