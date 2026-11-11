// The cell store of one workbook: its sheets by id, the string table and the shape table. It is built by one load
// from a description of the sheets and holds nothing a second load would not rebuild. A host writes a cell here as
// a literal, a formula in its stored text, or a clear; the recalc writes each formula's result into the same planes,
// so whoever reads a value never sees where it came from.

import { ShapeTable } from '../text/shapes';
import type { FormulaError } from '../values/errors';
import { ERRORS } from '../values/errors';
import type { Scalar } from '../values/value';
import type { Column } from './column';
import { CellKind, KIND_MASK } from './column';
import { Sheet } from './sheet';
import { StringTable } from './strings';

export type Literal = number | string | boolean | FormulaError;

// A formula comes as its stored text with the value it last had, or null for one that was never computed.
export type CellSink = (row: number, column: number, value: Literal | null, formula: string | null) => void;

// One sheet as a load takes it. `cells` reports every cell that holds something, in any order, and is called
// twice: once to size the columns and once to fill them. So a host walks its own cells and builds no list.
export type SheetSource = {
    readonly id: string;
    readonly name: string;
    readonly cells: (cell: CellSink) => void;
};

export class Workbook {
    public readonly sheets: readonly Sheet[];
    public readonly strings = new StringTable();
    public readonly shapes = new ShapeTable();
    private readonly byId = new Map<string, Sheet>();
    // The errors only a file knows, by their text. Their codes go on where the engine's own list ends.
    private readonly carried: FormulaError[] = [];
    private readonly carriedCodes = new Map<string, number>();

    public constructor(sources: readonly SheetSource[]) {
        this.sheets = sources.map((source) => {
            const lengths: number[] = [];
            source.cells((row, column, value, formula) => {
                if (value === null && formula === null) return;
                while (lengths.length <= column) lengths.push(0);
                if (row >= lengths[column]) lengths[column] = row + 1;
            });
            const sheet = new Sheet(source.id, lengths);
            this.byId.set(sheet.id, sheet);
            source.cells((row, column, value, formula) => {
                const held = sheet.columns[column];
                if (formula !== null) held.shape[row] = this.shapes.intern(formula);
                if (value !== null) this.put(held, row, value);
                else if (formula !== null) held.markDirty(row);
            });
            return sheet;
        });
    }

    public sheet(id: string): Sheet | undefined {
        return this.byId.get(id);
    }

    public value(column: Column, row: number): Scalar {
        if (row >= column.length) return null;
        switch (column.kind[row] & KIND_MASK) {
            case CellKind.Number:
                return column.num[row];
            case CellKind.Boolean:
                return column.ref[row] !== 0;
            case CellKind.Text:
                return this.strings.text(column.ref[row]);
            case CellKind.Error:
                return this.error(column.ref[row]);
            default:
                return null;
        }
    }

    public error(code: number): FormulaError {
        return code <= ERRORS.length ? ERRORS[code - 1] : this.carried[code - ERRORS.length - 1];
    }

    // Writes a value into a row the column already has. False when the cell already held it.
    public put(column: Column, row: number, value: Scalar): boolean {
        switch (typeof value) {
            case 'number':
                return column.put(row, CellKind.Number, value, 0);
            case 'boolean':
                return column.put(row, CellKind.Boolean, 0, value ? 1 : 0);
            case 'string':
                return column.put(row, CellKind.Text, 0, this.strings.intern(value));
            default:
                if (value === null) return column.put(row, CellKind.Empty, 0, 0);
                return column.put(row, CellKind.Error, 0, value.code || this.carry(value));
        }
    }

    public setValue(sheet: Sheet, row: number, column: number, value: Literal): void {
        const held = sheet.column(column);
        held.reach(row);
        held.settle(row);
        held.setShape(row, 0);
        this.put(held, row, value);
    }

    // The formula is to be computed: it holds no value until then.
    public setFormula(sheet: Sheet, row: number, column: number, text: string): void {
        const held = sheet.column(column);
        held.reach(row);
        held.setShape(row, this.shapes.intern(text));
        this.put(held, row, null);
        held.markDirty(row);
    }

    public clear(sheet: Sheet, row: number, column: number): void {
        const held = sheet.columns[column];
        if (held === undefined || row >= held.length) return;
        held.settle(row);
        held.setShape(row, 0);
        this.put(held, row, null);
        held.trim();
    }

    private carry(error: FormulaError): number {
        let code = this.carriedCodes.get(error.text);
        if (code === undefined) {
            this.carried.push(error);
            code = ERRORS.length + this.carried.length;
            this.carriedCodes.set(error.text, code);
        }
        return code;
    }
}
