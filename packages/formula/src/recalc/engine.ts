// The engine as a host holds it: one workbook loaded from a description of its sheets, the three writes of a cell,
// a recalc of what the writes reach, and the value of a cell. A sheet is named by its id and a cell by its row and
// column from 0. The functions are the library's list, the same for every engine. A host lets a stopped recalc run
// on before it writes more, or raises the cap: writes between every stopped recalc can keep one from ever finishing
// when the cap is no larger than the number of formulas that every recalc after a write computes again.

import { FUNCTIONS } from '../functions/library';
import type { Sheet } from '../store/sheet';
import type { Literal, SheetSource } from '../store/workbook';
import { Workbook } from '../store/workbook';
import type { Scalar } from '../values/value';
import type { RecalcResult } from './recalc';
import { Recalc } from './recalc';

export class Engine {
    private readonly workbook: Workbook;
    private readonly calc: Recalc;

    public constructor(sheets: readonly SheetSource[]) {
        this.workbook = new Workbook(sheets);
        this.calc = new Recalc(this.workbook, FUNCTIONS);
    }

    public setValue(sheet: string, row: number, column: number, value: Literal): void {
        const target = this.sheet(sheet);
        this.calc.touch(target, row, column, false);
        this.workbook.setValue(target, row, column, value);
    }

    // The formula in its stored text. It holds no value until a recalc computes it.
    public setFormula(sheet: string, row: number, column: number, text: string): void {
        const target = this.sheet(sheet);
        this.calc.touch(target, row, column, true);
        this.workbook.setFormula(target, row, column, text);
    }

    public clear(sheet: string, row: number, column: number): void {
        const target = this.sheet(sheet);
        this.calc.touch(target, row, column, false);
        this.workbook.clear(target, row, column);
    }

    // Computes the formulas that the writes since the last recalc reach: one that came with a value and reads
    // nothing written keeps it. After `cap` formulas the pass stops, and the next recalc goes on from there.
    public recalc(cap: number): RecalcResult {
        return this.calc.pass(cap);
    }

    // The value a cell holds. For a formula that is the last one a recalc computed.
    public valueOf(sheet: string, row: number, column: number): Scalar {
        const cells = this.sheet(sheet).columns[column];
        return cells === undefined ? null : this.workbook.value(cells, row);
    }

    private sheet(id: string): Sheet {
        const sheet = this.workbook.sheet(id);
        if (sheet === undefined) throw new Error(`No sheet ${id}`);
        return sheet;
    }
}
