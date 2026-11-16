// The engine as a host holds it: one workbook loaded from a description of its sheets, the writes of a cell, the
// structural edits, the clock of each batch of them, the rows a sheet hides or filters, a recalc of what they reach,
// and the reads, such as the value of a cell and a walk of a sheet. A sheet is named by its id and a cell by its row
// and column from 0. It reads the store and changes it only through the recalc. What a host can get wrong, such as a
// cell off the grid, is checked here, once, before anything is noted or changed: so a call that throws left the
// workbook as it was.

import type { Move } from '../edit/move';
import type { LineEdit } from '../edit/transform';
import { Fact } from '../eval/facts';
import { FUNCTIONS } from '../functions/library';
import { SETTLED } from '../store/column';
import type { Sheet } from '../store/sheet';
import type { CellSink, Literal, SheetSource } from '../store/workbook';
import { admit, admitRows, ChangeKind, isLine, Workbook } from '../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import type { Scalar } from '../values/value';
import { EditRefusal } from './edit-plan';
import type { EditResult, RecalcResult } from './recalc';
import { Recalc } from './recalc';

export class Engine {
    private readonly workbook: Pick<
        Workbook,
        'known' | 'sheets' | 'value' | 'shapes' | 'read' | 'checkId' | 'checkName'
    >;
    private readonly calc: Recalc;

    // A load, with the clock its values were computed with and whether a full pass computed them all, as `settled`
    // says of a walk. Then every value is trusted and a formula with no value is a blank result; else every formula
    // is to be computed. Either way one this build cannot evaluate keeps the value it came with, #REF! with none.
    public constructor(sheets: readonly SheetSource[], now: number, seed: number, computed: boolean) {
        clocked(now, seed);
        const workbook = new Workbook(sheets, computed);
        this.workbook = workbook;
        this.calc = new Recalc(workbook, FUNCTIONS, now, seed, computed);
    }

    // The clock of a batch of edits, once per batch: its author's time as a serial and a whole number its draws are
    // made of. The next recalc computes every formula that reads the clock or draws again, whatever was written.
    public setClock(now: number, seed: number): void {
        clocked(now, seed);
        this.calc.setClock(now, seed);
    }

    // The rows SUBTOTAL and AGGREGATE leave out: those hidden by hand and those a filter left out, each list whole,
    // as sorted pairs of a first and a last row. No edit moves one, so a host says them again before the next recalc.
    public setRowsOut(sheet: string, hidden: readonly number[], filtered: readonly number[]): void {
        const found = this.workbook.known(sheet);
        admitRows(hidden);
        admitRows(filtered);
        this.calc.setRowsOut(found, hidden, filtered);
    }

    public setValue(sheet: string, row: number, column: number, value: Literal): void {
        this.calc.setValue(this.cell(sheet, row, column, value), row, column, value);
    }

    // The formula in its stored text, with no value until a recalc computes it. One this build cannot evaluate holds
    // `given` at once, as an import or a paste brings it, and #REF! with none; any other ignores `given`.
    public setFormula(sheet: string, row: number, column: number, text: string, given: Literal | null = null): void {
        this.calc.fillFormula(this.cell(sheet, row, column, given), row, column, row, column, text, given);
    }

    // One stored text in every cell of a block, as a fill writes it and as undo puts a rewritten block back.
    public fillFormula(
        sheet: string,
        top: number,
        left: number,
        bottom: number,
        right: number,
        text: string,
        given: Literal | null = null,
    ): void {
        this.cell(sheet, bottom, right, given);
        if (top > bottom || left > right) throw new RangeError(`No block from ${top},${left} to ${bottom},${right}`);
        this.calc.fillFormula(this.cell(sheet, top, left), top, left, bottom, right, text, given);
    }

    public clear(sheet: string, row: number, column: number): void {
        this.calc.clear(this.cell(sheet, row, column), row, column);
    }

    // Inserts or deletes rows or columns: every formula keeps naming the cells it named. An insert that would
    // push a cell that holds a value or a formula past the last line of the grid is refused.
    public editLines(edit: LineEdit): EditResult {
        const sheet = this.workbook.known(edit.sheet);
        if (!isLine(edit.index, edit.rows ? GRID_ROWS : GRID_COLUMNS)) throw new RangeError(`No line ${edit.index}`);
        counted(edit.count);
        if (edit.insert && sheet.pushesOff(edit)) throw new EditRefusal('grid-end');
        return this.calc.edit({ kind: ChangeKind.Lines, edit });
    }

    // Moves a block of cells, as a cut and paste does, over whatever it lands on. The whole block lies on the
    // grid, where it is and where it goes.
    public moveCells(move: Move): EditResult {
        const { row, column, rows, columns, toRow, toColumn } = move;
        counted(rows);
        counted(columns);
        this.cell(move.fromSheet, row, column);
        this.cell(move.fromSheet, row + rows - 1, column + columns - 1);
        this.cell(move.toSheet, toRow, toColumn);
        this.cell(move.toSheet, toRow + rows - 1, toColumn + columns - 1);
        return this.calc.edit({ kind: ChangeKind.Move, move });
    }

    // Adds a sheet at a place among the tabs, from 0, read as a load that is not computed reads it. The result lists
    // the formulas of the other sheets that were typed with its name.
    public addSheet(source: SheetSource, place: number): EditResult {
        // The source is the host's code, so what is refused is checked once it has run. Whatever values its formulas
        // came with were computed against another workbook than this one.
        const draft = this.workbook.read(source, false);
        this.workbook.checkId(source.id);
        this.workbook.checkName(source.name, null);
        return this.calc.addSheet(draft, place);
    }

    // A formula that names the sheet keeps naming it, reads #REF!, and reads it again when the id comes back.
    public removeSheet(sheet: string): void {
        this.workbook.known(sheet);
        this.calc.edit({ kind: ChangeKind.RemoveSheet, sheet });
    }

    public renameSheet(sheet: string, name: string): EditResult {
        this.workbook.checkName(name, this.workbook.known(sheet));
        return this.calc.edit({ kind: ChangeKind.RenameSheet, sheet, name });
    }

    public moveSheet(sheet: string, place: number): void {
        this.workbook.known(sheet);
        this.calc.edit({ kind: ChangeKind.MoveSheet, sheet, place });
    }

    // Computes the formulas the writes and edits since the last recalc reach, and what a load left to compute. After
    // `cap` formulas the pass stops, and the next one goes on.
    public recalc(cap: number): RecalcResult {
        return this.calc.pass(cap);
    }

    // Whether every value is what a full pass computed: nothing written, edited, clocked or hidden since the last
    // pass, and nothing it left. Only then may a walk be loaded as computed, with the rows the sheets then left out.
    public settled(): boolean {
        return this.calc.settled();
    }

    // The value a cell holds. For a formula that is the last one a recalc computed.
    public valueOf(sheet: string, row: number, column: number): Scalar {
        const cells = this.workbook.known(sheet).columns[column];
        return cells === undefined ? null : this.workbook.value(cells, row);
    }

    // The stored text of the formula a cell holds, or null.
    public formulaOf(sheet: string, row: number, column: number): string | null {
        const cells = this.workbook.known(sheet).columns[column];
        const shape = cells === undefined || row >= cells.length ? 0 : cells.shape[row];
        // A row that is no row, such as -1, reads nothing off the column, as its value does.
        return shape > 0 ? this.workbook.shapes.shape(shape).text : null;
    }

    // Whether a cell holds a formula this build cannot evaluate, whose value is therefore given with it.
    public isGiven(sheet: string, row: number, column: number): boolean {
        const cells = this.workbook.known(sheet).columns[column];
        const shape = cells === undefined || row >= cells.length ? 0 : cells.shape[row];
        return shape > 0 && (this.calc.factsOf(shape) & Fact.Kept) !== 0;
    }

    // Whether a cell holds a formula that is still to be computed.
    public isPending(sheet: string, row: number, column: number): boolean {
        const cells = this.workbook.known(sheet).columns[column];
        return cells !== undefined && row < cells.length && cells.kind[row] > SETTLED;
    }

    // Reports the cells of a block that hold a value or a formula, a column at a time and down its rows, as a load
    // takes them. The sink must not write to the engine: after a write, what the walk reports is not defined.
    public cells(
        sheet: string,
        cell: CellSink,
        top = 0,
        left = 0,
        bottom = GRID_ROWS - 1,
        right = GRID_COLUMNS - 1,
    ): void {
        const { workbook } = this;
        const { columns } = workbook.known(sheet);
        if (!isLine(top, GRID_ROWS) || !isLine(left, GRID_COLUMNS)) return;
        const last = Math.min(right, columns.length - 1);
        for (let c = left; c <= last; c += 1) {
            const column = columns[c];
            const { kind, shape } = column;
            const end = Math.min(bottom + 1, column.length);
            for (let row = top; row < end; row += 1) {
                const id = shape[row];
                if (kind[row] === 0 && id === 0) continue;
                cell(row, c, workbook.value(column, row), id > 0 ? workbook.shapes.shape(id).text : null);
            }
        }
    }

    // The first row from `row` to `last` where a column holds a value or a formula, or -1.
    public nextCell(sheet: string, column: number, row: number, last: number): number {
        const cells = this.workbook.known(sheet).columns[column];
        if (cells === undefined || !isLine(row, GRID_ROWS)) return -1;
        const { kind, shape, length } = cells;
        const end = Math.min(last + 1, length);
        for (let at = row; at < end; at += 1) {
            if (kind[at] !== 0 || shape[at] !== 0) return at;
        }
        return -1;
    }

    // The rows a column holds: one past its last cell that holds a value or a formula.
    public columnLength(sheet: string, column: number): number {
        return this.workbook.known(sheet).columns[column]?.length ?? 0;
    }

    // The last row and the last column that hold a value or a formula, or -1 on an empty sheet.
    public lastRow(sheet: string): number {
        let rows = 0;
        for (const column of this.workbook.known(sheet).columns) rows = Math.max(rows, column.length);
        return rows - 1;
    }

    public lastColumn(sheet: string): number {
        const { columns } = this.workbook.known(sheet);
        let last = columns.length - 1;
        while (last >= 0 && columns[last].length === 0) last -= 1;
        return last;
    }

    // The rows every column of the workbook holds, together: what the cells cost, whatever room a column has.
    public slots(): number {
        let slots = 0;
        for (const sheet of this.workbook.sheets) {
            for (const column of sheet.columns) slots += column.length;
        }
        return slots;
    }

    // The sheet of a cell a host names: it must exist, as the cell must on the grid, and its value be one to hold.
    private cell(sheet: string, row: number, column: number, value: Literal | null = null): Sheet {
        const found = this.workbook.known(sheet);
        admit(row, column, value);
        return found;
    }
}

// Throws unless it is a clock: a time, and a whole number to draw from.
function clocked(now: number, seed: number): void {
    if (!Number.isFinite(now) || !Number.isInteger(seed)) throw new RangeError(`No clock ${now}, ${seed}`);
}

// Throws unless it counts lines: a whole number of them, and at least one.
function counted(count: number): void {
    if (!Number.isInteger(count) || count < 1) throw new RangeError(`No count ${count}`);
}
