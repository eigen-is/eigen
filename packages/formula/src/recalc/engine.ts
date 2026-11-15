// The engine as a host holds it: one workbook loaded from a description of its sheets, the writes of a cell, the
// structural edits, the clock of each batch of them, a recalc of what they reach, and the reads, such as the value
// of a cell and a walk of a sheet.
// A sheet is named by its id and a cell by its row and column from 0. It reads the store and changes it only
// through the recalc. What a host can get wrong, such as a sheet that is not there or a cell off the grid, is
// checked here, once, before anything is noted or changed: so a call that throws left the workbook as it was.

import type { Move } from '../edit/move';
import type { LineEdit } from '../edit/transform';
import { FUNCTIONS } from '../functions/library';
import { SETTLED } from '../store/column';
import type { Sheet } from '../store/sheet';
import type { CellSink, Literal, SheetSource } from '../store/workbook';
import { admit, ChangeKind, isLine, Workbook } from '../store/workbook';
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

    // A load, with the clock its values were computed with: a clock formula keeps the value it came with.
    public constructor(sheets: readonly SheetSource[], now = 0, seed = 0) {
        clocked(now, seed);
        const workbook = new Workbook(sheets);
        this.workbook = workbook;
        this.calc = new Recalc(workbook, FUNCTIONS, now, seed);
    }

    // The clock of a batch of edits, once per batch: its author's time as a serial and a whole number its draws are
    // made of. The next recalc computes every formula that reads the clock or draws again, whatever was written.
    public setClock(now: number, seed: number): void {
        clocked(now, seed);
        this.calc.setClock(now, seed);
    }

    public setValue(sheet: string, row: number, column: number, value: Literal): void {
        this.calc.setValue(this.cell(sheet, row, column, value), row, column, value);
    }

    // The formula in its stored text. It holds no value until a recalc computes it.
    public setFormula(sheet: string, row: number, column: number, text: string): void {
        this.calc.fillFormula(this.cell(sheet, row, column), row, column, row, column, text);
    }

    // One stored text in every cell of a block, as a fill writes it and as undo puts a rewritten block back.
    public fillFormula(sheet: string, top: number, left: number, bottom: number, right: number, text: string): void {
        this.cell(sheet, bottom, right);
        if (top > bottom || left > right) throw new RangeError(`No block from ${top},${left} to ${bottom},${right}`);
        this.calc.fillFormula(this.cell(sheet, top, left), top, left, bottom, right, text);
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

    // Adds a sheet at a place among the tabs, from 0. Its formulas are computed by the next recalc whatever
    // values they came with, and the result lists the formulas that now read a sheet by the name they were typed with.
    public addSheet(source: SheetSource, place: number): EditResult {
        // The source is the host's code, so what is refused is checked once it has run.
        const draft = this.workbook.read(source);
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

    // Computes the formulas the writes and edits since the last recalc reach: one that came with a value other than
    // #REF! and reads nothing written keeps it. After `cap` formulas the pass stops, and the next one goes on.
    public recalc(cap: number): RecalcResult {
        return this.calc.pass(cap);
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

    // The first row at or after `row` where a column holds a value or a formula, or -1.
    public nextCell(sheet: string, column: number, row: number): number {
        const cells = this.workbook.known(sheet).columns[column];
        if (cells === undefined || !isLine(row, GRID_ROWS)) return -1;
        const { kind, shape, length } = cells;
        for (let at = row; at < length; at += 1) {
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

    // The id of the sheet at a place among the tabs, which is how a recalc names the sheet of a changed cell.
    public sheetAt(place: number): string {
        return this.workbook.known(place).id;
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
