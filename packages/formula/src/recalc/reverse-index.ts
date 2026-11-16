// The reverse index of a workbook: which formulas read a cell. `Recalc` rebuilds it whole from the shape planes when
// a formula came or went, and has it mark: flag every formula that reads a written cell or a formula flagged here.
// Cells of one shape in a block share their entries, about one per reference, which a `Listing` finds by the rows
// and the column of a span. A second listing holds the boxes around what formulas worked out as they ran, an entry
// per box, built again whenever a record changed.

import { Fact } from '../eval/facts';
import type { Column } from '../store/column';
import type { Workbook } from '../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { RefFlag, RefKind, SheetKind } from '../text/tree';
import { flag, Listing, RANGE } from './listing';

export class ReverseIndex {
    // The spans a marking has still to follow: sheet, column, first and last row.
    private readonly work: number[] = [];
    // What the references of the shapes read, and what the formulas resolved when they were last computed.
    private readonly named = new Listing(this.work);
    private readonly resolved = new Listing(this.work);
    // The rectangles whose shape asks the workbook itself: sheet, first and last column and row.
    private unnamed: number[] = [];
    // The rectangles whose shape works a reference out as it runs, in the same five numbers.
    private resolving: number[] = [];
    // The rectangles whose shape reads the clock or draws, in the same five numbers.
    public clocks: readonly number[] = [];
    // Every block of cells of one shape, as the last rebuild found them: sheet, first and last column, first and
    // last row, and shape.
    public rectangles: readonly number[] = [];

    // The facts of every shape a cell holds are to be worked out.
    public rebuild(workbook: Workbook): void {
        const { sheets, shapes } = workbook;
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
        this.rectangles = rectangles;
        const entries: number[] = [];
        // Per sheet, what each entry reads of it: first and last row, first and last column, and the entry.
        const areas: number[][] = sheets.map(() => []);
        this.unnamed = [];
        this.resolving = [];
        const clocks: number[] = [];
        this.clocks = clocks;
        for (let r = 0; r < rectangles.length; r += 6) {
            const s = rectangles[r];
            const id = rectangles[r + 5];
            const facts = shapes.facts[id];
            if (facts & Fact.Kept) continue;
            if (facts & Fact.ReadsUnnamed) this.unnamed.push(...rectangles.slice(r, r + 5));
            if (facts & Fact.Resolves) this.resolving.push(...rectangles.slice(r, r + 5));
            if (facts & Fact.Clock) clocks.push(...rectangles.slice(r, r + 5));
            for (const ref of shapes.shape(id).refs) {
                const { op, sheetKind, flags } = ref;
                const target =
                    sheetKind === SheetKind.Host
                        ? s
                        : sheetKind === SheetKind.Id
                          ? workbook.sheet(ref.sheet)?.place
                          : undefined;
                if (target === undefined) continue;
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

    // Lists the boxes of the records: per column and row of a formula, five numbers a box, the sheet first.
    public resolve(workbook: Workbook, records: ReadonlyMap<Column, ReadonlyMap<number, readonly number[]>>): void {
        const { sheets } = workbook;
        const entries: number[] = [];
        const areas: number[][] = sheets.map(() => []);
        for (let s = 0; s < sheets.length; s += 1) {
            const { columns } = sheets[s];
            for (let c = 0; c < columns.length; c += 1) {
                for (const [row, record] of records.get(columns[c]) ?? []) {
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
        }
        this.resolved.build(entries, areas);
    }

    // Flags every formula that reads a seed or a formula flagged here, each once, and every formula that asks
    // the workbook itself; with `resolving`, every formula that works a reference out too, as no record says what
    // they read. A seed is a span of rows: sheet, column, first and last row.
    public mark(workbook: Workbook, seeds: readonly number[], resolving: boolean): void {
        const { sheets } = workbook;
        const { named, resolved, work } = this;
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
            resolved.follow(sheets, sheet, column, from, to);
        }
        named.restore();
        resolved.restore();
    }
}
