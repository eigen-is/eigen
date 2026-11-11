// The reverse index of a workbook: which formulas read a cell. Nothing else stores a dependency, and this is
// derived whole from the shape planes, never patched. Cells that hold one shape in a block, equal runs down
// neighbouring columns, are one rectangle, and each reference of the shape is one entry for all of it, in the list
// of the sheet it reads. A recalc marks from its seeds: an entry whose area holds a written span gives the hosts
// that read it by arithmetic, and each formula flagged that way is followed in turn.

import { Fact } from '../eval/facts';
import type { Column } from '../store/column';
import { SETTLED } from '../store/column';
import type { Workbook } from '../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { RefFlag, RefKind, SheetKind } from '../text/tree';

// An entry is this many numbers: the area all its hosts read, the largest last row of the entries up to it, the
// hosts, the two ends of the reference along the rows and along the columns, and which of the four move with a host.
const STRIDE = 16;
const TOP = 0;
const BOTTOM = 1;
const LEFT = 2;
const RIGHT = 3;
const REACH = 4;
const HOST_SHEET = 5;
const HOST_TOP = 6;
const HOST_BOTTOM = 7;
const HOST_LEFT = 8;
const HOST_RIGHT = 9;
const ROW_ENDS = 10;
const COLUMN_ENDS = 12;
const MOVES = 14;

export class ReverseIndex {
    // Per sheet that is read, its entries sorted by the first row of their area.
    private lists: Int32Array[] = [];
    // The rectangles whose shape reads cells its references do not name: sheet, first and last column and row.
    private unnamed: number[] = [];
    // Per sheet and column, how many formulas it holds.
    private formulas: Int32Array[] = [];

    // `facts` holds the facts of every shape, by its id.
    public rebuild(workbook: Workbook, facts: readonly number[]): void {
        const { sheets, shapes } = workbook;
        // Sheet, first and last column, first and last row, and shape of every rectangle.
        const rectangles: number[] = [];
        this.formulas = sheets.map((sheet) => new Int32Array(sheet.columns.length));
        for (let s = 0; s < sheets.length; s += 1) {
            // The runs of the column before, from the top down: first row, last row, shape, and where in the list
            // its rectangle starts.
            let open: number[] = [];
            for (let c = 0; c < sheets[s].columns.length; c += 1) {
                const { shape, length } = sheets[s].columns[c];
                const runs: number[] = [];
                let o = 0;
                let row = 0;
                while (row < length) {
                    const id = shape[row];
                    const first = row;
                    row += 1;
                    if (id === 0) continue;
                    while (row < length && shape[row] === id) row += 1;
                    this.formulas[s][c] += row - first;
                    while (o < open.length && open[o] < first) o += 4;
                    if (open[o] === first && open[o + 1] === row - 1 && open[o + 2] === id) {
                        rectangles[open[o + 3] + 2] = c;
                        runs.push(first, row - 1, id, open[o + 3]);
                    } else {
                        runs.push(first, row - 1, id, rectangles.length);
                        rectangles.push(s, c, c, first, row - 1, id);
                    }
                }
                open = runs;
            }
        }
        const ids = sheets.map((sheet) => sheet.id);
        const found: number[][] = sheets.map(() => []);
        this.unnamed = [];
        for (let r = 0; r < rectangles.length; r += 6) {
            const s = rectangles[r];
            const id = rectangles[r + 5];
            if (facts[id] & Fact.Kept) continue;
            if (facts[id] & Fact.ReadsUnnamed) this.unnamed.push(...rectangles.slice(r, r + 5));
            for (const ref of shapes.shape(id).refs) {
                const { op, sheetKind, flags } = ref;
                const target =
                    sheetKind === SheetKind.Host ? s : sheetKind === SheetKind.Id ? ids.indexOf(ref.sheet) : -1;
                if (target < 0) continue;
                // Each end as where it sits for a host at 0 and how far it moves with the host, 0 or 1.
                let { row, row2, column, column2 } = ref;
                let rowStep = flags & RefFlag.RowAbsolute ? 0 : 1;
                let row2Step = flags & RefFlag.Row2Absolute ? 0 : 1;
                let columnStep = flags & RefFlag.ColumnAbsolute ? 0 : 1;
                let column2Step = flags & RefFlag.Column2Absolute ? 0 : 1;
                if (op === RefKind.Cell) {
                    row2 = row;
                    row2Step = rowStep;
                    column2 = column;
                    column2Step = columnStep;
                } else if (op === RefKind.Columns) {
                    row = 0;
                    row2 = GRID_ROWS - 1;
                    rowStep = 0;
                    row2Step = 0;
                } else if (op === RefKind.Rows) {
                    column = 0;
                    column2 = GRID_COLUMNS - 1;
                    columnStep = 0;
                    column2Step = 0;
                }
                // A host at which the reference leaves the grid reads nothing.
                const top = Math.max(rectangles[r + 3], -row * rowStep, -row2 * row2Step);
                const bottom = Math.min(
                    rectangles[r + 4],
                    GRID_ROWS - 1 - row * rowStep,
                    GRID_ROWS - 1 - row2 * row2Step,
                );
                const left = Math.max(rectangles[r + 1], -column * columnStep, -column2 * column2Step);
                const right = Math.min(
                    rectangles[r + 2],
                    GRID_COLUMNS - 1 - column * columnStep,
                    GRID_COLUMNS - 1 - column2 * column2Step,
                );
                if (top > bottom || left > right) continue;
                found[target].push(
                    Math.min(row + top * rowStep, row2 + top * row2Step),
                    Math.max(row + bottom * rowStep, row2 + bottom * row2Step),
                    Math.min(column + left * columnStep, column2 + left * column2Step),
                    Math.max(column + right * columnStep, column2 + right * column2Step),
                    0,
                    s,
                    top,
                    bottom,
                    left,
                    right,
                    row,
                    row2,
                    column,
                    column2,
                    rowStep | (row2Step << 1) | (columnStep << 2) | (column2Step << 3),
                    0,
                );
            }
        }
        this.lists = found.map((entries) => {
            const count = entries.length / STRIDE;
            // The first row and the place of each entry in one number, so that a plain sort orders them by row.
            const order = new Float64Array(count);
            for (let i = 0; i < count; i += 1) order[i] = entries[i * STRIDE] * count + i;
            order.sort();
            const list = new Int32Array(entries.length);
            let reach = -1;
            for (let i = 0; i < count; i += 1) {
                const from = (order[i] % count) * STRIDE;
                for (let field = 0; field < STRIDE; field += 1) list[i * STRIDE + field] = entries[from + field];
                reach = Math.max(reach, list[i * STRIDE + BOTTOM]);
                list[i * STRIDE + REACH] = reach;
            }
            return list;
        });
    }

    // Flags every formula that reads a seed or a formula flagged here, each once, and with any seed at all every
    // formula that reads cells it does not name. A seed is a span of rows: sheet, column, first and last row.
    public mark(workbook: Workbook, seeds: readonly number[]): void {
        if (seeds.length === 0) return;
        const { sheets } = workbook;
        const { unnamed } = this;
        const work = seeds.slice();
        for (let i = 0; i < unnamed.length; i += 5) {
            const { columns } = sheets[unnamed[i]];
            for (let c = unnamed[i + 1]; c <= unnamed[i + 2]; c += 1) {
                this.flag(work, unnamed[i], c, columns[c], unnamed[i + 3], unnamed[i + 4]);
            }
        }
        for (let at = 0; at < work.length; at += 4) {
            const list = this.lists[work[at]];
            const column = work[at + 1];
            const from = work[at + 2];
            const to = work[at + 3];
            let low = 0;
            let high = list.length / STRIDE;
            while (low < high) {
                const middle = (low + high) >> 1;
                if (list[middle * STRIDE + TOP] <= to) low = middle + 1;
                else high = middle;
            }
            // Every entry from here up starts at or above the span, and none before `e` reaches down to it.
            for (let e = (low - 1) * STRIDE; e >= 0 && list[e + REACH] >= from; e -= STRIDE) {
                if (list[e + BOTTOM] < from || list[e + LEFT] > column || list[e + RIGHT] < column) continue;
                const moves = list[e + MOVES];
                const host = list[e + HOST_SHEET];
                const top = Math.max(list[e + HOST_TOP], firstHost(from, list, e + ROW_ENDS, moves));
                const bottom = Math.min(list[e + HOST_BOTTOM], lastHost(to, list, e + ROW_ENDS, moves));
                const left = Math.max(list[e + HOST_LEFT], firstHost(column, list, e + COLUMN_ENDS, moves >> 2));
                const right = Math.min(list[e + HOST_RIGHT], lastHost(column, list, e + COLUMN_ENDS, moves >> 2));
                for (let c = left; c <= right; c += 1) this.flag(work, host, c, sheets[host].columns[c], top, bottom);
            }
        }
    }

    // Flags the formulas of some rows of one column that are not flagged yet, and adds each run of them to the work.
    private flag(work: number[], sheet: number, column: number, held: Column, top: number, bottom: number): void {
        if (held.pending === this.formulas[sheet][column]) return;
        let first = -1;
        for (let row = top; row <= bottom; row += 1) {
            if (held.kind[row] <= SETTLED) {
                held.markDirty(row);
                if (first < 0) first = row;
            } else if (first >= 0) {
                work.push(sheet, column, first, row - 1);
                first = -1;
            }
        }
        if (first >= 0) work.push(sheet, column, first, bottom);
    }
}

// Along one axis, the first host whose reference reaches `from` or past it, which it does as soon as one of its
// two ends does. The ends sit at `ends` in the list, and the two low bits of `moves` say which move with the host.
function firstHost(from: number, list: Int32Array, ends: number, moves: number): number {
    const all = Number.NEGATIVE_INFINITY;
    const first = moves & 1 ? from - list[ends] : list[ends] >= from ? all : -all;
    const first2 = moves & 2 ? from - list[ends + 1] : list[ends + 1] >= from ? all : -all;
    return Math.min(first, first2);
}

// The last host whose reference starts at `to` or before it.
function lastHost(to: number, list: Int32Array, ends: number, moves: number): number {
    const all = Number.POSITIVE_INFINITY;
    const last = moves & 1 ? to - list[ends] : list[ends] <= to ? all : -all;
    const last2 = moves & 2 ? to - list[ends + 1] : list[ends + 1] <= to ? all : -all;
    return Math.max(last, last2);
}
