// The engine as a host holds it: one workbook loaded from a description of its sheets, the three writes of a cell,
// a full recalc, and the value of a cell. A sheet is named by its id and a cell by its row and column from 0. The
// functions are the library's list, the same for every engine.

import { FUNCTIONS } from '../functions/library';
import type { Sheet } from '../store/sheet';
import type { Literal, SheetSource } from '../store/workbook';
import { Workbook } from '../store/workbook';
import type { Scalar } from '../values/value';
import type { RecalcResult } from './recalc';
import { Recalc } from './recalc';

export class Engine {
    private readonly workbook: Workbook;
    private readonly cells: Recalc;

    public constructor(sheets: readonly SheetSource[]) {
        this.workbook = new Workbook(sheets);
        this.cells = new Recalc(this.workbook, FUNCTIONS);
    }

    public setValue(sheet: string, row: number, column: number, value: Literal): void {
        this.workbook.setValue(this.sheet(sheet), row, column, value);
    }

    // The formula in its stored text. It is computed when its value is next asked for, or by a recalc.
    public setFormula(sheet: string, row: number, column: number, text: string): void {
        this.workbook.setFormula(this.sheet(sheet), row, column, text);
    }

    public clear(sheet: string, row: number, column: number): void {
        this.workbook.clear(this.sheet(sheet), row, column);
    }

    // Computes every formula again. `cap` is how many cells the pass may read before it is abandoned whole.
    public recalc(cap: number): RecalcResult {
        return this.cells.all(cap);
    }

    public valueOf(sheet: string, row: number, column: number): Scalar {
        return this.cells.valueOf(this.sheet(sheet), column, row);
    }

    private sheet(id: string): Sheet {
        const sheet = this.workbook.sheet(id);
        if (sheet === undefined) throw new Error(`No sheet ${id}`);
        return sheet;
    }
}
