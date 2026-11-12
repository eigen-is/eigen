// The engine as a host holds it: one workbook loaded from a description of its sheets, the writes of a cell, the
// structural edits, a recalc of what they reach, and the value and the formula of a cell. A sheet is named by its
// id and a cell by its row and column from 0. It reads the store and changes it only through the recalc. A host
// lets a stopped recalc run on before it writes more, or raises the cap: writes between every stopped recalc can
// keep one from ever finishing when the cap is no larger than what every recalc after a write computes again.
// What makes it refuse a write or an edit is checked here, once, before anything is noted or changed: a sheet
// that is not there, a cell off the grid, a count that is none. So a call that throws left the workbook as it was.

import type { Move } from '../edit/move';
import type { LineEdit } from '../edit/transform';
import { FUNCTIONS } from '../functions/library';
import { SETTLED } from '../store/column';
import type { Sheet } from '../store/sheet';
import type { Literal, SheetSource } from '../store/workbook';
import { ChangeKind, Workbook } from '../store/workbook';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import type { Scalar } from '../values/value';
import type { EditResult, RecalcResult } from './recalc';
import { Recalc } from './recalc';

export class Engine {
    private readonly workbook: Pick<Workbook, 'sheet' | 'known' | 'value' | 'sheets' | 'shapes'>;
    private readonly calc: Recalc;

    public constructor(sheets: readonly SheetSource[]) {
        const workbook = new Workbook(sheets);
        this.workbook = workbook;
        this.calc = new Recalc(workbook, FUNCTIONS);
    }

    public setValue(sheet: string, row: number, column: number, value: Literal): void {
        this.calc.setValue(this.cell(sheet, row, column), row, column, value);
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

    // Inserts or deletes rows or columns. Every formula keeps naming the cells it named: the result lists the
    // blocks of formulas whose stored text changed, and those whose old text only the host can keep for undo.
    // Cells an insert pushes past the last line are gone and counted; refusing such an insert is the host's.
    public editLines(edit: LineEdit): EditResult {
        this.workbook.known(edit.sheet);
        if (!within(edit.index, edit.rows ? GRID_ROWS : GRID_COLUMNS)) throw new RangeError(`No line ${edit.index}`);
        counted(edit.count);
        return this.calc.edit({ kind: ChangeKind.Lines, edit });
    }

    // Moves a block of cells, as a cut and paste does, over whatever it lands on. A block as high or as wide as
    // the grid is a block like any other. The block is what lies on the grid, before and after: what would land
    // past the last line is cleared and counted instead.
    public moveCells(move: Move): EditResult {
        const from = this.cell(move.fromSheet, move.row, move.column);
        this.cell(move.toSheet, move.toRow, move.toColumn);
        counted(move.rows);
        counted(move.columns);
        const rows = Math.min(move.rows, GRID_ROWS - move.row, GRID_ROWS - move.toRow);
        const columns = Math.min(move.columns, GRID_COLUMNS - move.column, GRID_COLUMNS - move.toColumn);
        let dropped = 0;
        for (let c = move.column; c < Math.min(move.column + move.columns, from.columns.length); c += 1) {
            const held = from.columns[c];
            for (let row = move.row; row < Math.min(move.row + move.rows, held.length); row += 1) {
                if (row - move.row < rows && c - move.column < columns) continue;
                if (held.kind[row] === 0 && held.shape[row] === 0) continue;
                this.calc.clear(from, row, c);
                dropped += 1;
            }
        }
        const { rewrites } = this.calc.edit({ kind: ChangeKind.Move, move: { ...move, rows, columns } });
        return { rewrites, dropped };
    }

    // Adds a sheet at a place among the tabs, from 0. Its formulas are computed by the next recalc whatever
    // values they came with. A formula typed with its name while no sheet had it now reads it, and a formula of
    // its own typed with the name of a sheet that is there reads that one: the result lists both.
    public addSheet(source: SheetSource, place: number): EditResult {
        if (this.workbook.sheet(source.id) !== undefined) throw new Error(`Sheet ${source.id} exists`);
        return this.calc.addSheet(source, place);
    }

    // A formula that names the sheet keeps naming it, reads #REF!, and reads it again when the id comes back.
    public removeSheet(sheet: string): void {
        this.workbook.known(sheet);
        this.calc.edit({ kind: ChangeKind.RemoveSheet, sheet });
    }

    public renameSheet(sheet: string, name: string): EditResult {
        this.workbook.known(sheet);
        return this.calc.edit({ kind: ChangeKind.RenameSheet, sheet, name });
    }

    public moveSheet(sheet: string, place: number): void {
        this.workbook.known(sheet);
        this.calc.edit({ kind: ChangeKind.MoveSheet, sheet, place });
    }

    // Computes the formulas that the writes and edits since the last recalc reach: one that came with a value and
    // reads nothing written keeps it. After `cap` formulas the pass stops, and the next recalc goes on from there.
    public recalc(cap: number, now = 0, seed = 0): RecalcResult {
        return this.calc.pass(cap, now, seed);
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
        return shape === 0 ? null : this.workbook.shapes.shape(shape).text;
    }

    // Whether a cell holds a formula that is still to be computed.
    public isPending(sheet: string, row: number, column: number): boolean {
        const cells = this.workbook.known(sheet).columns[column];
        return cells !== undefined && row < cells.length && cells.kind[row] > SETTLED;
    }

    // The id of the sheet at a place among the tabs, which is how a recalc names the sheet of a changed cell.
    public sheetAt(place: number): string {
        return this.workbook.sheets[place].id;
    }

    // The sheet of a cell a host names, which must exist, as the cell must on the grid.
    private cell(sheet: string, row: number, column: number): Sheet {
        const found = this.workbook.known(sheet);
        if (!within(row, GRID_ROWS) || !within(column, GRID_COLUMNS)) throw new RangeError(`No cell ${row},${column}`);
        return found;
    }
}

function within(line: number, lines: number): boolean {
    return Number.isInteger(line) && line >= 0 && line < lines;
}

// Throws unless it counts lines: a whole number of them, and at least one.
function counted(count: number): void {
    if (!Number.isInteger(count) || count < 1) throw new RangeError(`No count ${count}`);
}
