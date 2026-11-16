// The reverse index of a workbook: which formulas read a cell. `Recalc` says which sheets' formulas changed and has
// it rebuilt: the blocks of cells of one shape are found again in the columns of those sheets alone, and what every
// block reads is listed again whole, so nothing here is patched. Then it marks: it flags every formula that reads a
// written cell or a formula flagged here. A block shares its entries, about one per reference, which a `Listing`
// finds by the rows and the column of a span. A second listing holds the boxes around what formulas worked out as
// they ran, an entry per box, built again whenever a record changed.

import { Fact } from '../eval/facts';
import type { Sheet } from '../store/sheet';
import type { Workbook } from '../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { RefFlag, RefKind, SheetKind } from '../text/tree';
import { flag, Listing, RANGE } from './listing';

export class ReverseIndex {
    // The spans a marking has still to follow: sheet, column, first and last row.
    private readonly work: number[] = [];
    // What the references of the shapes read, and what the formulas resolved when they were last computed.
    private readonly named = new Listing(this.work);
    private readonly recorded = new Listing(this.work);
    // The rectangles whose shape asks the workbook itself: sheet, first and last column and row.
    private unnamed: number[] = [];
    // The rectangles whose shape works a reference out as it runs, in the same five numbers.
    private resolving: number[] = [];
    // The rectangles whose shape reads the clock or draws, in the same five numbers.
    public clocks: readonly number[] = [];
    // The rectangles whose shape leaves rows out, as SUBTOTAL does, once per reference with the sheet it names, and
    // once with -1 for any sheet when the shape works a reference out: that number, then the same five.
    public choosers: readonly number[] = [];
    // Every block of cells of one shape, as the last rebuild found them: sheet, first and last column, first and
    // last row, and shape.
    public rectangles: readonly number[] = [];
    // Per sheet, its blocks as they were last found in its columns, in the same numbers but the sheet, in the order
    // of their first column. A sheet whose formulas came, went or moved since is not here.
    private readonly blocks = new WeakMap<Sheet, readonly number[]>();
    // The sheets whose blocks here are the blocks their columns hold.
    private readonly fresh = new WeakSet<Sheet>();
    // Whether the workbook changed since the last rebuild in a way the index lists: a formula, or a sheet's place.
    public stale = true;

    // Formulas of a sheet came, went or moved, or the sheet did: the next rebuild reads all its columns.
    public forget(sheet: Sheet): void {
        this.blocks.delete(sheet);
        this.reshape(sheet);
    }

    // Formulas of a sheet got another shape where they are: the next rebuild reads the columns of its blocks.
    public reshape(sheet: Sheet): void {
        this.fresh.delete(sheet);
        this.stale = true;
    }

    // Finds the blocks of the sheets that changed in their columns, and lists again what every block of the
    // workbook reads. The facts of every shape a cell holds are to be worked out.
    public rebuild(workbook: Workbook): void {
        const { sheets, shapes } = workbook;
        const rectangles: number[] = [];
        for (let s = 0; s < sheets.length; s += 1) {
            let found = this.blocks.get(sheets[s]);
            if (found === undefined || !this.fresh.has(sheets[s])) {
                const blocks: number[] = [];
                const { columns } = sheets[s];
                // Formulas that only got another shape lie in the columns of the blocks the sheet had: of those,
                // the first one that reaches the column or lies past it.
                const had = found;
                let h = 0;
                // The runs of the column before, from the top down: first row, last row, shape, and where in the
                // list its block starts. The two lists swap from column to column.
                let open: number[] = [];
                let runs: number[] = [];
                let opened = 0;
                for (let c = 0; c < columns.length; c += 1) {
                    if (had !== undefined) {
                        while (h < had.length && had[h + 1] < c) h += 5;
                        if (h === had.length) break;
                        // The columns up to that block hold no formula, so no run of them goes on.
                        if (had[h] > c) {
                            c = had[h];
                            opened = 0;
                        }
                    }
                    const { shape, length } = columns[c];
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
                        runs[ran + 3] = joins ? open[o + 3] : blocks.length;
                        ran += 4;
                        if (joins) blocks[open[o + 3] + 1] = c;
                        else blocks.push(c, c, first, row - 1, id);
                    }
                    const before = open;
                    open = runs;
                    runs = before;
                    opened = ran;
                }
                this.blocks.set(sheets[s], blocks);
                this.fresh.add(sheets[s]);
                found = blocks;
            }
            for (let b = 0; b < found.length; b += 5) {
                rectangles.push(s, found[b], found[b + 1], found[b + 2], found[b + 3], found[b + 4]);
            }
        }
        this.rectangles = rectangles;
        this.stale = false;
        const entries: number[] = [];
        // Per sheet, what each entry reads of it: first and last row, first and last column, and the entry.
        const areas: number[][] = sheets.map(() => []);
        this.unnamed = [];
        this.resolving = [];
        const clocks: number[] = [];
        this.clocks = clocks;
        const choosers: number[] = [];
        this.choosers = choosers;
        for (let r = 0; r < rectangles.length; r += 6) {
            const s = rectangles[r];
            const id = rectangles[r + 5];
            const facts = shapes.facts[id];
            if (facts & Fact.Kept) continue;
            if (facts & Fact.ReadsUnnamed) this.unnamed.push(...rectangles.slice(r, r + 5));
            if (facts & Fact.Resolves) this.resolving.push(...rectangles.slice(r, r + 5));
            if (facts & Fact.Clock) clocks.push(...rectangles.slice(r, r + 5));
            // A shape that leaves rows out is listed under the sheet of each reference it names, and under any
            // sheet when it works a reference out.
            const chooses = (facts & Fact.Chosen) !== 0;
            if (chooses && (facts & Fact.Resolves) !== 0) choosers.push(-1, ...rectangles.slice(r, r + 5));
            for (const ref of shapes.shape(id).refs) {
                const { op, sheetKind, flags } = ref;
                const target =
                    sheetKind === SheetKind.Host
                        ? s
                        : sheetKind === SheetKind.Id
                          ? workbook.sheet(ref.sheet)?.place
                          : undefined;
                if (target === undefined) continue;
                if (chooses) choosers.push(target, ...rectangles.slice(r, r + 5));
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
                    entries.push(s, top, bottom, first, last, row, row2, column, column2, moves, 0, -1);
                }
            }
        }
        this.named.build(entries, areas);
    }

    // Lists the boxes of the records of a workbook of so many sheets: per column of a formula, as the place of its
    // sheet times the columns of the grid plus its own, and per row, five numbers a box, the sheet first.
    public listRecords(sheets: number, records: ReadonlyMap<number, ReadonlyMap<number, readonly number[]>>): void {
        const entries: number[] = [];
        const areas: number[][] = Array.from({ length: sheets }, () => []);
        for (const [at, rows] of records) {
            const s = Math.floor(at / GRID_COLUMNS);
            const c = at % GRID_COLUMNS;
            for (const [row, record] of rows) {
                for (let a = 0; a < record.length; a += 5) {
                    const top = record[a + 1];
                    const left = record[a + 2];
                    const bottom = record[a + 3];
                    const right = record[a + 4];
                    areas[record[a]].push(top, bottom, left, right, entries.length);
                    // As a range, so that a marking is done with the entry once its cell is flagged.
                    entries.push(s, row, row, c, c, top, bottom, left, right, RANGE, 0, -1);
                }
            }
        }
        this.recorded.build(entries, areas);
    }

    // Flags every formula that reads a seed or a formula flagged here, each once, and every formula that asks
    // the workbook itself; with `resolving`, every formula that works a reference out too, as no record says what
    // they read. A seed is a span of rows: sheet, column, first and last row.
    public mark(workbook: Workbook, seeds: readonly number[], resolving: boolean): void {
        const { sheets } = workbook;
        const { named, recorded, work } = this;
        for (const seed of seeds) work.push(seed);
        for (const rectangles of resolving ? [this.unnamed, this.resolving] : [this.unnamed]) {
            for (let i = 0; i < rectangles.length; i += 5) {
                const { columns } = sheets[rectangles[i]];
                for (let c = rectangles[i + 1]; c <= rectangles[i + 2]; c += 1) {
                    flag(work, rectangles[i], c, columns[c], rectangles[i + 3], rectangles[i + 4]);
                }
            }
        }
        while (work.length > 0) {
            const span = work.length - 4;
            const sheet = work[span];
            const column = work[span + 1];
            const from = work[span + 2];
            const to = work[span + 3];
            work.length = span;
            named.follow(sheets, sheet, column, from, to);
            recorded.follow(sheets, sheet, column, from, to);
        }
        named.restore();
        recorded.restore();
    }
}
