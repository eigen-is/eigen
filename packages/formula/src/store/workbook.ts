// The cell store of one workbook: its sheets in tab order and by id, the string table and the shape table. It is
// built by one load from a description of the sheets and holds nothing a second load would not rebuild; a source
// never calls back into the engine while its cells are read, as its sheet is not the workbook's yet. A host writes a
// literal, a formula in its stored text, or a clear; the recalc writes each result into the same planes, so a reader
// never sees where a value came from. `apply` is the one way cells move and sheets come and go.

import type { Move } from '../edit/move';
import type { LineEdit } from '../edit/transform';
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

// A structural edit. A sheet is added as `load` made it, at a place among the tabs, and moved to one; both count
// from 0.
export const ChangeKind = { Lines: 0, Move: 1, AddSheet: 2, RemoveSheet: 3, RenameSheet: 4, MoveSheet: 5 } as const;

export type Change =
    | { readonly kind: typeof ChangeKind.Lines; readonly edit: LineEdit }
    | { readonly kind: typeof ChangeKind.Move; readonly move: Move }
    | { readonly kind: typeof ChangeKind.AddSheet; readonly sheet: Sheet; readonly place: number }
    | { readonly kind: typeof ChangeKind.RemoveSheet; readonly sheet: string }
    | { readonly kind: typeof ChangeKind.RenameSheet; readonly sheet: string; readonly name: string }
    | { readonly kind: typeof ChangeKind.MoveSheet; readonly sheet: string; readonly place: number };

// A string table that weighs less, in characters, is not swept: the texts no cell holds then cost a few megabytes
// at most, and a sweep reads every cell.
export const SWEEP_FLOOR = 2 ** 22;

export class Workbook {
    private readonly held: Sheet[] = [];
    public readonly strings = new StringTable();
    public readonly shapes = new ShapeTable();
    private readonly byId = new Map<string, Sheet>();
    // The errors only a file knows, by their text. Their codes go on where the engine's own list ends.
    private readonly carried: FormulaError[] = [];
    private readonly carriedCodes = new Map<string, number>();
    // The weight of the string table past which the next pass sweeps it: twice what it was after the last sweep or
    // load and the floor at least, and 0 once a sheet was removed.
    private limit: number;

    public constructor(sources: readonly SheetSource[]) {
        for (const source of sources) this.insert(this.load(source), this.held.length);
        this.limit = Math.max(SWEEP_FLOOR, 2 * this.strings.weight);
    }

    // The sheets in tab order: each one's `place` is where it sits here.
    public get sheets(): readonly Sheet[] {
        return this.held;
    }

    public sheet(id: string): Sheet | undefined {
        return this.byId.get(id);
    }

    // The sheet of an id a host gave, which must exist.
    public known(id: string): Sheet {
        const sheet = this.byId.get(id);
        if (sheet === undefined) throw new Error(`No sheet ${id}`);
        return sheet;
    }

    // One sheet from its description, in no place yet: `apply` adds it.
    public load(source: SheetSource): Sheet {
        const lengths: number[] = [];
        source.cells((row, column, value, formula) => {
            if (value === null && formula === null) return;
            while (lengths.length <= column) lengths.push(0);
            if (row >= lengths[column]) lengths[column] = row + 1;
        });
        const sheet = new Sheet(source.id, source.name, lengths);
        source.cells((row, column, value, formula) => {
            const held = sheet.columns[column];
            if (formula !== null) held.shape[row] = this.shapes.intern(formula);
            if (value !== null) this.put(held, row, value);
            else if (formula !== null) held.markDirty(row);
        });
        return sheet;
    }

    // Writes the new shape of each block of formulas an edit rewrites, in the places before the edit, then performs
    // the edit, so the shapes travel with their cells. Returns how many cells the edit pushed off the grid.
    public apply(change: Change, fills: readonly number[]): number {
        for (let f = 0; f < fills.length; f += 6) {
            const { columns } = this.held[fills[f]];
            for (let c = fills[f + 1]; c <= fills[f + 2]; c += 1) {
                columns[c].fillShape(fills[f + 3], fills[f + 4], fills[f + 5]);
            }
        }
        switch (change.kind) {
            case ChangeKind.Lines: {
                const { insert, index, count, rows } = change.edit;
                const sheet = this.known(change.edit.sheet);
                if (insert) return rows ? sheet.insertRows(index, count) : sheet.insertColumns(index, count);
                if (rows) sheet.deleteRows(index, count);
                else sheet.deleteColumns(index, count);
                return 0;
            }
            case ChangeKind.Move:
                return this.known(change.move.toSheet).moveFrom(this.known(change.move.fromSheet), change.move);
            case ChangeKind.AddSheet:
                // Whatever values its formulas came with were computed against another workbook than this one.
                for (const column of change.sheet.columns) {
                    for (let row = 0; row < column.length; row += 1) {
                        if (column.shape[row] !== 0) column.markDirty(row);
                    }
                }
                this.insert(change.sheet, change.place);
                return 0;
            case ChangeKind.RemoveSheet: {
                const sheet = this.known(change.sheet);
                this.held.splice(sheet.place, 1);
                this.byId.delete(sheet.id);
                this.limit = 0;
                for (let s = sheet.place; s < this.held.length; s += 1) this.held[s].place = s;
                return 0;
            }
            case ChangeKind.RenameSheet:
                this.known(change.sheet).name = change.name;
                return 0;
            default: {
                const sheet = this.known(change.sheet);
                this.held.splice(sheet.place, 1);
                this.insert(sheet, change.place);
                return 0;
            }
        }
    }

    // Has the string table forget the texts no cell holds, once it is past its limit. For the start of a pass: no
    // formula is running, and every sheet that holds a text is in the workbook.
    public sweep(): void {
        const { strings } = this;
        if (strings.weight <= this.limit) return;
        const held = new Uint8Array(strings.size);
        for (const sheet of this.held) {
            for (const { kind, ref, length } of sheet.columns) {
                for (let row = 0; row < length; row += 1) {
                    if ((kind[row] & KIND_MASK) === CellKind.Text) held[ref[row]] = 1;
                }
            }
        }
        strings.keep(held);
        this.limit = Math.max(SWEEP_FLOOR, 2 * strings.weight);
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

    // One formula in its stored text in every cell of a block. It is to be computed: it holds no value until then.
    public fillFormula(sheet: Sheet, top: number, left: number, bottom: number, right: number, text: string): void {
        const shape = this.shapes.intern(text);
        for (let c = left; c <= right; c += 1) {
            const held = sheet.column(c);
            held.reach(bottom);
            for (let row = top; row <= bottom; row += 1) {
                held.setShape(row, shape);
                this.put(held, row, null);
                held.markDirty(row);
            }
        }
    }

    public clear(sheet: Sheet, row: number, column: number): void {
        const held = sheet.columns[column];
        if (held === undefined || row >= held.length) return;
        held.settle(row);
        held.setShape(row, 0);
        this.put(held, row, null);
        held.trim();
    }

    // Puts a sheet at a place among the tabs, the last one when the place is past it.
    private insert(sheet: Sheet, place: number): void {
        this.held.splice(Math.max(0, Math.min(place, this.held.length)), 0, sheet);
        this.byId.set(sheet.id, sheet);
        for (let s = 0; s < this.held.length; s += 1) this.held[s].place = s;
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
