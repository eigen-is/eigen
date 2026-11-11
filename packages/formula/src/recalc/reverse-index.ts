// The reverse index of a workbook: which formulas read a cell. Nothing else stores a dependency, and this is
// derived whole from the shape planes, never patched, so it answers for the formulas as they were at its rebuild.
// Cells that hold one shape in a block are one rectangle, and each reference of the shape is one entry for all of
// it. The sheet an entry reads lists it under the few aligned blocks of columns, each a power of two wide, that
// tile its columns, sorted by row in each, so a lookup for a cell tests rows only. A marking starts from its seeds:
// an entry that reads a span gives the hosts that read it by arithmetic, and each formula flagged is followed.

import { Fact } from '../eval/facts';
import type { Column } from '../store/column';
import { SETTLED } from '../store/column';
import type { Sheet } from '../store/sheet';
import type { Workbook } from '../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { RefFlag, RefKind, SheetKind } from '../text/tree';

// An entry is twelve numbers: its hosts, the two ends of the reference along the rows and along the columns,
// which of the four move with a host, and for a range the host rows it flagged in the marking that is running.
const HOST_SHEET = 0;
const HOST_TOP = 1;
const HOST_BOTTOM = 2;
const HOST_LEFT = 3;
const HOST_RIGHT = 4;
const ROW_ENDS = 5;
const COLUMN_ENDS = 7;
const MOVES = 9;
const FLAGGED = 10;
const FLAGGED_END = 11;
// Beside the four bits of `MOVES`: the reference is a range.
const RANGE = 16;

// The widest block is the whole grid.
const LEVELS = Math.log2(GRID_COLUMNS) + 1;

// A listing is four numbers: the rows its entry reads, and the largest last row among the listings of the stretch
// it is the middle of whose entry may still have a host to flag.
const TOP = 0;
const BOTTOM = 1;
const REACH = 2;
const ENTRY = 3;

export class ReverseIndex {
    private entries = new Int32Array(0);
    // Per sheet that is read, its listings: block by block, the narrowest blocks first, sorted by first row in each.
    private lists: Int32Array[] = [];
    // Per sheet, where the listings of each block start, with one more at the end, and per width of block in use
    // four numbers: the power of two, its first and last block in use, and where its first block sits in `starts`.
    private starts: Int32Array[] = [];
    private levels: number[][] = [];
    // The rectangles whose shape reads cells its references do not name: sheet, first and last column and row.
    private unnamed: number[] = [];
    // The spans a marking has still to follow: sheet, column, first and last row.
    private work: number[] = [];
    // What a marking wrote here and puts back before it returns: the sheet, place and old value of each `REACH`
    // it lowered, and the entries that hold flagged rows.
    private readonly lowered: number[] = [];
    private readonly recorded: number[] = [];

    // `facts` holds the facts of every shape, by its id.
    public rebuild(workbook: Workbook, facts: readonly number[]): void {
        const { sheets, shapes } = workbook;
        // Sheet, first and last column, first and last row, and shape of every rectangle.
        const rectangles: number[] = [];
        for (let s = 0; s < sheets.length; s += 1) {
            // The runs of the column before, from the top down: first row, last row, shape, and where in the list
            // its rectangle starts. The two lists swap from column to column.
            let open: number[] = [];
            let runs: number[] = [];
            let opened = 0;
            for (let c = 0; c < sheets[s].columns.length; c += 1) {
                const { shape, length } = sheets[s].columns[c];
                let ran = 0;
                let o = 0;
                let row = 0;
                while (row < length) {
                    const id = shape[row];
                    const first = row;
                    row += 1;
                    if (id === 0) continue;
                    while (row < length && shape[row] === id) row += 1;
                    while (o < opened && open[o] < first) o += 4;
                    const joins = o < opened && open[o] === first && open[o + 1] === row - 1 && open[o + 2] === id;
                    runs[ran] = first;
                    runs[ran + 1] = row - 1;
                    runs[ran + 2] = id;
                    runs[ran + 3] = joins ? open[o + 3] : rectangles.length;
                    ran += 4;
                    if (joins) rectangles[open[o + 3] + 2] = c;
                    else rectangles.push(s, c, c, first, row - 1, id);
                }
                const before = open;
                open = runs;
                runs = before;
                opened = ran;
            }
        }
        const ids = sheets.map((sheet) => sheet.id);
        const entries: number[] = [];
        // Per sheet, what each entry reads of it: first and last row, first and last column, and the entry.
        const areas: number[][] = sheets.map(() => []);
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
                const range = op === RefKind.Cell ? 0 : RANGE;
                const moves = rowStep | (row2Step << 1) | (columnStep << 2) | (column2Step << 3) | range;
                // A range whose columns move is an entry per host column, so that the hosts of every range entry
                // read the same rows of the same columns, and one record of flagged rows holds for all of them.
                const width = range !== 0 && (columnStep | column2Step) !== 0 ? 1 : right - left + 1;
                for (let first = left; first <= right; first += width) {
                    const last = first + width - 1;
                    areas[target].push(
                        Math.min(row + top * rowStep, row2 + top * row2Step),
                        Math.max(row + bottom * rowStep, row2 + bottom * row2Step),
                        Math.min(column + first * columnStep, column2 + first * column2Step),
                        Math.max(column + last * columnStep, column2 + last * column2Step),
                        entries.length,
                    );
                    entries.push(s, top, bottom, first, last, row, row2, column, column2, moves, 0, 0);
                }
            }
        }
        this.entries = new Int32Array(entries);
        this.lists = [];
        this.starts = [];
        this.levels = [];
        for (const read of areas) {
            const count = read.length / 5;
            // The first row and the place of each area in one number, so that a plain sort orders them by row.
            const order = new Float64Array(count);
            for (let i = 0; i < count; i += 1) order[i] = read[i * 5] * count + i;
            order.sort();
            // The blocks that tile the columns of each area, in that order: power of two, block and area.
            const tiles: number[] = [];
            // Per power of two, its first and last block in use.
            const firsts = new Int32Array(LEVELS).fill(GRID_COLUMNS);
            const lasts = new Int32Array(LEVELS).fill(-1);
            for (let i = 0; i < count; i += 1) {
                const area = (order[i] - Math.floor(order[i] / count) * count) * 5;
                let low = read[area + 2];
                let high = read[area + 3] + 1;
                for (let level = 0; low < high; level += 1) {
                    // An odd end is a block of its own: its neighbor pairs with a column outside the area.
                    if (low & 1) {
                        tiles.push(level, low, area);
                        low += 1;
                    }
                    if (high & 1) {
                        high -= 1;
                        tiles.push(level, high, area);
                    }
                    low >>= 1;
                    high >>= 1;
                }
            }
            for (let t = 0; t < tiles.length; t += 3) {
                const level = tiles[t];
                if (tiles[t + 1] < firsts[level]) firsts[level] = tiles[t + 1];
                if (tiles[t + 1] > lasts[level]) lasts[level] = tiles[t + 1];
            }
            const levels: number[] = [];
            // Per power of two, where its block 0 would sit in `starts`.
            const bases = new Int32Array(LEVELS);
            let slots = 0;
            for (let level = 0; level < LEVELS; level += 1) {
                if (lasts[level] < 0) continue;
                levels.push(level, firsts[level], lasts[level], slots);
                bases[level] = slots - firsts[level];
                slots += lasts[level] - firsts[level] + 1;
            }
            const starts = new Int32Array(slots + 1);
            for (let t = 0; t < tiles.length; t += 3) starts[bases[tiles[t]] + tiles[t + 1] + 1] += 1;
            for (let slot = 0; slot < slots; slot += 1) starts[slot + 1] += starts[slot];
            const list = new Int32Array((tiles.length / 3) * 4);
            const next = starts.slice();
            // The tiles come in row order, so every block is filled in row order.
            for (let t = 0; t < tiles.length; t += 3) {
                const slot = bases[tiles[t]] + tiles[t + 1];
                const at = next[slot] * 4;
                next[slot] += 1;
                list[at + TOP] = read[tiles[t + 2]];
                list[at + BOTTOM] = read[tiles[t + 2] + 1];
                list[at + ENTRY] = read[tiles[t + 2] + 4];
            }
            for (let slot = 0; slot < slots; slot += 1) reachOf(list, starts[slot], starts[slot + 1]);
            this.lists.push(list);
            this.starts.push(starts);
            this.levels.push(levels);
        }
    }

    // Flags every formula that reads a seed or a formula flagged here, each once, and with any seed at all every
    // formula that reads cells it does not name. A seed is a span of rows: sheet, column, first and last row.
    public mark(workbook: Workbook, seeds: readonly number[]): void {
        if (seeds.length === 0) return;
        const { sheets } = workbook;
        const { unnamed, entries, lowered, recorded } = this;
        this.work = seeds.slice();
        const { work } = this;
        for (let i = 0; i < unnamed.length; i += 5) {
            const { columns } = sheets[unnamed[i]];
            for (let c = unnamed[i + 1]; c <= unnamed[i + 2]; c += 1) {
                this.flag(unnamed[i], c, columns[c], unnamed[i + 3], unnamed[i + 4]);
            }
        }
        while (work.length > 0) {
            const span = work.length - 4;
            const sheet = work[span];
            const column = work[span + 1];
            const from = work[span + 2];
            const to = work[span + 3];
            work.length = span;
            const starts = this.starts[sheet];
            const levels = this.levels[sheet];
            for (let l = 0; l < levels.length; l += 4) {
                const block = column >> levels[l];
                if (block < levels[l + 1] || block > levels[l + 2]) continue;
                const slot = levels[l + 3] + block - levels[l + 1];
                if (starts[slot] < starts[slot + 1]) {
                    this.search(sheets, sheet, starts[slot], starts[slot + 1], column, from, to);
                }
            }
        }
        for (let i = lowered.length - 3; i >= 0; i -= 3) this.lists[lowered[i]][lowered[i + 1]] = lowered[i + 2];
        for (const entry of recorded) {
            entries[entry + FLAGGED] = 0;
            entries[entry + FLAGGED_END] = 0;
        }
        lowered.length = 0;
        recorded.length = 0;
    }

    // Flags the hosts of the listings from `low` up to `high` of one sheet that read a span, and gives the largest
    // last row among those whose entry may still have a host to flag.
    private search(
        sheets: readonly Sheet[],
        sheet: number,
        low: number,
        high: number,
        column: number,
        from: number,
        to: number,
    ): number {
        const list = this.lists[sheet];
        const middle = (low + high) >> 1;
        const at = middle * 4;
        const reach = list[at + REACH];
        if (reach < from) return reach;
        const before = low < middle ? this.search(sheets, sheet, low, middle, column, from, to) : -1;
        // The listings after this one start lower still.
        if (list[at + TOP] > to) return reach;
        let own = list[at + BOTTOM];
        if (own >= from) {
            const { entries } = this;
            const entry = list[at + ENTRY];
            const moves = entries[entry + MOVES];
            const host = entries[entry + HOST_SHEET];
            const top = Math.max(entries[entry + HOST_TOP], firstHost(from, entries, entry + ROW_ENDS, moves));
            const bottom = Math.min(entries[entry + HOST_BOTTOM], lastHost(to, entries, entry + ROW_ENDS, moves));
            const left = Math.max(
                entries[entry + HOST_LEFT],
                firstHost(column, entries, entry + COLUMN_ENDS, moves >> 2),
            );
            const right = Math.min(
                entries[entry + HOST_RIGHT],
                lastHost(column, entries, entry + COLUMN_ENDS, moves >> 2),
            );
            const flagged = entries[entry + FLAGGED];
            const end = entries[entry + FLAGGED_END];
            // Rows the entry flagged in this marking are flagged in every host column, so only the rows on
            // either side of them are scanned. Rows apart from them start the record again.
            const apart = (moves & RANGE) === 0 || top > end || bottom + 1 < flagged;
            for (let c = left; c <= right; c += 1) {
                const held = sheets[host].columns[c];
                if (apart) this.flag(host, c, held, top, bottom);
                else {
                    this.flag(host, c, held, top, flagged - 1);
                    this.flag(host, c, held, end, bottom);
                }
            }
            if (moves & RANGE && top <= bottom) {
                if (end === 0) this.recorded.push(entry);
                entries[entry + FLAGGED] = apart ? top : Math.min(top, flagged);
                entries[entry + FLAGGED_END] = apart ? bottom + 1 : Math.max(bottom + 1, end);
                const all =
                    entries[entry + FLAGGED] <= entries[entry + HOST_TOP] &&
                    entries[entry + FLAGGED_END] > entries[entry + HOST_BOTTOM];
                if (all) own = -1;
            }
        }
        const after = middle + 1 < high ? this.search(sheets, sheet, middle + 1, high, column, from, to) : -1;
        const live = Math.max(before, own, after);
        if (live < reach) {
            this.lowered.push(sheet, at + REACH, reach);
            list[at + REACH] = live;
        }
        return live;
    }

    // Flags the formulas of some rows of one column that are not flagged yet, and adds each run of them to the work.
    private flag(sheet: number, column: number, held: Column, top: number, bottom: number): void {
        const { work } = this;
        const { kind } = held;
        let first = -1;
        // One row past the last closes a run that goes on to the end.
        for (let row = top; row <= bottom + 1; row += 1) {
            if (row <= bottom && kind[row] <= SETTLED) {
                held.markDirty(row);
                if (first < 0) first = row;
            } else if (first >= 0) {
                const last = work.length - 4;
                // A run that goes on where the span on top ends is one span with it.
                if (last >= 0 && work[last] === sheet && work[last + 1] === column && work[last + 3] === first - 1) {
                    work[last + 3] = row - 1;
                } else work.push(sheet, column, first, row - 1);
                first = -1;
            }
        }
    }
}

// Stores at the middle listing of every stretch from `low` up to `high` the largest last row in the stretch.
function reachOf(list: Int32Array, low: number, high: number): number {
    if (low >= high) return -1;
    const middle = (low + high) >> 1;
    const reach = Math.max(reachOf(list, low, middle), list[middle * 4 + BOTTOM], reachOf(list, middle + 1, high));
    list[middle * 4 + REACH] = reach;
    return reach;
}

// Along one axis, the first host whose reference reaches `from` or past it, which it does as soon as one of its
// two ends does. The ends sit at `ends` in the entries, and the two low bits of `moves` say which move with the host.
function firstHost(from: number, entries: Int32Array, ends: number, moves: number): number {
    const all = Number.NEGATIVE_INFINITY;
    const first = moves & 1 ? from - entries[ends] : entries[ends] >= from ? all : -all;
    const first2 = moves & 2 ? from - entries[ends + 1] : entries[ends + 1] >= from ? all : -all;
    return Math.min(first, first2);
}

// The last host whose reference starts at `to` or before it.
function lastHost(to: number, entries: Int32Array, ends: number, moves: number): number {
    const all = Number.POSITIVE_INFINITY;
    const last = moves & 1 ? to - entries[ends] : entries[ends] <= to ? all : -all;
    const last2 = moves & 2 ? to - entries[ends + 1] : entries[ends + 1] <= to ? all : -all;
    return Math.max(last, last2);
}
