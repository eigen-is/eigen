// Reading the cells a reference names: where its first error sits, and the array it becomes when its elements are
// needed. The array stores one row for every row of the area that holds a cell and one for every stretch of rows
// that hold none, and its columns the same way, so a reference costs the cells that exist, wherever they lie. A
// function gets that array filled with the values; an operator gets its rows and columns, and reads the cells
// where they lie.

import type { Column } from '../store/column';
import { CellKind, KIND_MASK } from '../store/column';
import { GRID_ROWS } from '../text/a1';
import type { FormulaError } from '../values/errors';
import { CALC } from '../values/errors';
import type { ArrayValue, Reference, Scalar } from '../values/value';
import { arrayOf, heightOf, ValueType, widthOf } from '../values/value';
import type { Evaluator } from './evaluator';
import { skipped } from './walk';

// The first error of one area, row by row, once its cells are settled. A cell on a loop still carries its flags.
// `skips` says which cells the walk of the call passes over: an error in one of them is none.
export function firstError(ctx: Evaluator, area: Reference, skips: number): FormulaError | null {
    const { columns } = ctx.workbook.sheets[area.sheet];
    const right = Math.min(area.right, columns.length - 1);
    let found: FormulaError | null = null;
    let foundRow = GRID_ROWS;
    for (let c = area.left; c <= right; c += 1) {
        const column = columns[c];
        if (column.errors === 0) continue;
        const end = Math.min(area.bottom + 1, column.length, foundRow);
        for (let row = area.top; row < end; row += 1) {
            if ((column.kind[row] & KIND_MASK) !== CellKind.Error || skipped(ctx, skips, column, row)) continue;
            found = ctx.workbook.error(column.ref[row]);
            foundRow = row;
            break;
        }
    }
    return found;
}

// A range as the array it is read as, with its cells left on the sheet: the size that was written and the rows
// and columns the array stores, each for a run of written ones.
export class Banded {
    public readonly rows: number;
    public readonly columns: number;
    public readonly height: number;
    public readonly width: number;
    public readonly rowEnds: Int32Array | null;
    public readonly columnEnds: Int32Array | null;
    private readonly held: readonly Column[];
    private readonly top: number;
    private readonly left: number;

    public constructor(
        held: readonly Column[],
        area: Reference,
        rowEnds: Int32Array | null,
        columnEnds: Int32Array | null,
    ) {
        this.held = held;
        this.top = area.top;
        this.left = area.left;
        this.rows = heightOf(area);
        this.columns = widthOf(area);
        this.height = rowEnds?.length ?? this.rows;
        this.width = columnEnds?.length ?? this.columns;
        this.rowEnds = rowEnds;
        this.columnEnds = columnEnds;
    }

    // The row of the sheet that a stored row reads: the first of the rows it stands for.
    public row(stored: number): number {
        const { rowEnds } = this;
        return this.top + (rowEnds === null || stored === 0 ? stored : rowEnds[stored - 1]);
    }

    // The column of the sheet that a stored column reads, which the sheet may not have.
    public column(stored: number): Column | undefined {
        const { columnEnds } = this;
        return this.held[this.left + (columnEnds === null || stored === 0 ? stored : columnEnds[stored - 1])];
    }
}

// One area with its formulas computed, banded as the array of its cells, or the cell itself when there is one.
export function band(ctx: Evaluator, area: Reference): Scalar | Banded {
    ctx.recalc.settleArea(area);
    const { top, left } = area;
    const sheet = ctx.workbook.sheets[area.sheet].columns;
    const rows = heightOf(area);
    const columns = widthOf(area);
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
    const banded = new Banded(sheet, area, runs(filledRows, down, rows), runs(filledColumns, across, columns));
    if (!ctx.recalc.room(banded.height * banded.width)) return CALC;
    if (rows * columns > 1) return banded;
    return across === 0 ? null : ctx.workbook.value(sheet[left], top);
}

// The cells of one area as an array of their values, or the cell itself when there is one.
export function toArray(ctx: Evaluator, area: Reference): Scalar | ArrayValue {
    const banded = band(ctx, area);
    if (!(banded instanceof Banded)) return banded;
    const { rows, columns, height, width, rowEnds, columnEnds } = banded;
    // Filled with blanks one by one and never made at its size, which would slow every reference read after it.
    const items: Scalar[] = [];
    for (let at = height * width; at > 0; at -= 1) items.push(null);
    for (let j = 0; j < width; j += 1) {
        const column = banded.column(j);
        if (column === undefined) continue;
        for (let i = 0; i < height; i += 1) items[i * width + j] = ctx.workbook.value(column, banded.row(i));
    }
    // Not looked through for an array of numbers: what reads a range as an array reads it element by element.
    return {
        type: ValueType.Array,
        rows,
        columns,
        height,
        width,
        items,
        nums: null,
        rowEnds,
        columnEnds,
        references: false,
    };
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

// What an element that is a reference takes of an array's room, which counts an element as a number.
const REFERENCE_ROOM = 17;

// The cells of the first area of a reference, each as a reference of its own, stored as `toArray` stores a range:
// a stretch that holds no cell is one run, whose element is the reference to that whole stretch.
export function cellsOf(ctx: Evaluator, area: Reference): Reference | ArrayValue | FormulaError {
    const { type, sheet, top, left } = area;
    const rows = heightOf(area);
    const columns = widthOf(area);
    if (rows * columns === 1) return area.next === null ? area : { ...area, next: null };
    const held = ctx.workbook.sheets[sheet].columns;
    const across = Math.max(0, Math.min(columns, held.length - left));
    let down = 0;
    for (let c = 0; c < across; c += 1) down = Math.max(down, Math.min(rows, held[left + c].length - top));
    const filledRows = ctx.marks(down, true);
    const filledColumns = ctx.marks(across, false);
    for (let c = 0; c < across; c += 1) {
        const { kind, shape, length } = held[left + c];
        const end = Math.min(rows, length - top);
        for (let r = 0; r < end; r += 1) {
            if (kind[top + r] === 0 && shape[top + r] === 0) continue;
            filledRows[r] = 1;
            filledColumns[c] = 1;
        }
    }
    const rowEnds = runs(filledRows, down, rows);
    const columnEnds = runs(filledColumns, across, columns);
    const height = rowEnds?.length ?? rows;
    const width = columnEnds?.length ?? columns;
    if (!ctx.recalc.room(height * width * REFERENCE_ROOM)) return CALC;
    const items: Reference[] = [];
    for (let i = 0; i < height; i += 1) {
        const first = top + (rowEnds === null || i === 0 ? i : rowEnds[i - 1]);
        const last = top + (rowEnds === null ? i : rowEnds[i] - 1);
        for (let j = 0; j < width; j += 1) {
            const start = left + (columnEnds === null || j === 0 ? j : columnEnds[j - 1]);
            const end = left + (columnEnds === null ? j : columnEnds[j] - 1);
            items.push({ type, sheet, top: first, left: start, bottom: last, right: end, next: null });
        }
    }
    return arrayOf(rows, columns, items, rowEnds, columnEnds, true);
}
