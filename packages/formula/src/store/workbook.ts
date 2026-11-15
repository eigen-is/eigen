// The cell store of one workbook: its sheets in tab order, by id and by name, the string table and the shape table.
// It is built by one load from a description of the sheets and holds nothing a second load would not rebuild; a
// sheet is read from its source to the end before a table holds any of it. A host writes a literal, a formula in its
// stored text, or a clear; the recalc writes each result into the same planes, so a reader never sees where a value
// came from. `apply` is the one way cells move and sheets come and go.

import type { Move } from '../edit/move';
import type { LineEdit } from '../edit/transform';
import { GRID_COLUMNS, GRID_ROWS } from '../text/a1';
import { ShapeTable } from '../text/shapes';
import { sheetNameKey } from '../text/sheet-name';
import type { FormulaError } from '../values/errors';
import { ERRORS, errorOf, REF } from '../values/errors';
import type { Scalar } from '../values/value';
import type { Column } from './column';
import { CellKind, KIND_MASK } from './column';
import { Sheet } from './sheet';
import { StringTable } from './strings';

export type Literal = number | string | boolean | FormulaError;

// A formula comes as its stored text with the value it last had, or null for one that was never computed.
export type CellSink = (row: number, column: number, value: Literal | null, formula: string | null) => void;

// One sheet as a load takes it. `cells` reports every cell that holds something, in any order, and is called
// twice with the same cells, to size the columns and then to fill them: a host walks its own and builds no list.
export type SheetSource = {
    readonly id: string;
    readonly name: string;
    readonly cells: (cell: CellSink) => void;
};

// A sheet as `read` leaves it: a text cell, a formula and an error only a file knows hold the complement of their
// number in these lists, below 0 where no id or code is, which `adopt` turns into ids and codes of the tables.
export type Draft = {
    readonly sheet: Sheet;
    readonly texts: ReadonlyMap<string, number>;
    readonly formulas: ReadonlyMap<string, number>;
    readonly errors: ReadonlyMap<string, number>;
    // Per column, the rows of the cells that may hold such a number, as the source reported them.
    readonly numbered: readonly (readonly number[])[];
};

// A structural edit. A sheet is added as `adopt` made it, at a place among the tabs, and moved to one; both count
// from 0.
export const ChangeKind = { Lines: 0, Move: 1, AddSheet: 2, RemoveSheet: 3, RenameSheet: 4, MoveSheet: 5 } as const;

export type Change =
    | { readonly kind: typeof ChangeKind.Lines; readonly edit: LineEdit }
    | { readonly kind: typeof ChangeKind.Move; readonly move: Move }
    | { readonly kind: typeof ChangeKind.AddSheet; readonly sheet: Sheet; readonly place: number }
    | { readonly kind: typeof ChangeKind.RemoveSheet; readonly sheet: string }
    | { readonly kind: typeof ChangeKind.RenameSheet; readonly sheet: string; readonly name: string }
    | { readonly kind: typeof ChangeKind.MoveSheet; readonly sheet: string; readonly place: number };

// The store's door for a cell a host hands it, in a write or in a load: throws unless the cell is on the grid and
// its value, when a number, is one a cell can hold.
export function admit(row: number, column: number, value: Literal | null): void {
    if (!isLine(row, GRID_ROWS) || !isLine(column, GRID_COLUMNS)) throw new RangeError(`No cell ${row},${column}`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`No number ${value}`);
}

export function isLine(line: number, lines: number): boolean {
    return Number.isInteger(line) && line >= 0 && line < lines;
}

// The code of the first error only a file knows: their codes go on where the engine's own list ends.
const CARRIED = ERRORS.length + 1;

// A string table that weighs less, in characters, is not swept: the texts no cell holds then cost a few megabytes
// at most, and a sweep reads every cell.
export const SWEEP_FLOOR = 2 ** 22;

export class Workbook {
    private readonly held: Sheet[] = [];
    public readonly strings = new StringTable();
    public readonly shapes = new ShapeTable();
    private readonly byId = new Map<string, Sheet>();
    // The sheets by the key of their name, which no two share.
    private readonly byName = new Map<string, Sheet>();
    // The errors only a file knows, by their text.
    private readonly carried: FormulaError[] = [];
    private readonly carriedCodes = new Map<string, number>();
    // The weight of the string table past which the next pass sweeps it: twice what it was after the last sweep or
    // load and the floor at least, and 0 once a sheet was removed.
    private limit: number;

    public constructor(sources: readonly SheetSource[]) {
        // Every sheet has its place before a formula is read, so one may name a sheet that comes after its own.
        const drafts = sources.map((source) => {
            this.checkId(source.id);
            this.checkName(source.name, null);
            const draft = this.read(source);
            this.insert(draft.sheet, this.held.length);
            return draft;
        });
        for (const draft of drafts) this.adopt(draft);
        this.limit = Math.max(SWEEP_FLOOR, 2 * this.strings.weight);
    }

    // The sheets in tab order: each one's `place` is where it sits here.
    public get sheets(): readonly Sheet[] {
        return this.held;
    }

    public sheet(id: string): Sheet | undefined {
        return this.byId.get(id);
    }

    // The sheet a host names, by its id or by its place among the tabs, which must exist.
    public known(sheet: string | number): Sheet {
        const found = typeof sheet === 'string' ? this.byId.get(sheet) : this.held[sheet];
        if (found === undefined) throw new Error(`No sheet ${sheet}`);
        return found;
    }

    // The sheet a name typed in a formula reads, in any case.
    public named(name: string): Sheet | undefined {
        return this.byName.get(sheetNameKey(name));
    }

    // Throws when a sheet has the id: a host names a sheet by it.
    public checkId(id: string): void {
        if (this.byId.has(id)) throw new Error(`Sheet ${id} exists`);
    }

    // Throws when a sheet other than `holder` has the name, as two sheet names are compared: a name a formula is
    // typed with would read either of them.
    public checkName(name: string, holder: Sheet | null): void {
        const named = this.named(name);
        if (named !== undefined && named !== holder) throw new Error(`Sheet name ${name} is in use`);
    }

    // Reads one sheet from its description to the end, with the workbook's tables untouched: whatever the source
    // does while it is read, such as a call of the engine, meets the workbook as it was.
    public read(source: SheetSource): Draft {
        const lengths: number[] = [];
        walk(source, (row, column) => {
            while (lengths.length <= column) lengths.push(0);
            if (row >= lengths[column]) lengths[column] = row + 1;
        });
        const sheet = new Sheet(source.id, source.name, lengths);
        const texts = new Map<string, number>();
        const formulas = new Map<string, number>();
        const errors = new Map<string, number>();
        const numbered = lengths.map((): number[] => []);
        walk(source, (row, column, value, formula) => {
            const held = sheet.columns[column];
            if (held === undefined || row >= held.length) {
                throw new Error(`Sheet ${source.id} reported cell ${row},${column} only when it was read again`);
            }
            if (formula !== null) held.shape[row] = ~listed(formulas, formula);
            if (typeof value === 'string') held.put(row, CellKind.Text, 0, ~listed(texts, value));
            else if (typeof value === 'object' && value !== null) {
                held.put(row, CellKind.Error, 0, value.code || ~listed(errors, value.text));
            } else if (value !== null) this.put(held, row, value);
            // A number or a boolean with no formula is stored as it stays.
            if (formula !== null || (typeof value !== 'number' && typeof value !== 'boolean')) {
                numbered[column].push(row);
            }
            // A formula that came with no value was never computed, and one that came with #REF! may be on a loop,
            // which only computing it finds. A host's error is told by its code, as the cell stores it.
            if (formula !== null && (value === null || (typeof value === 'object' && value.code === REF.code))) {
                held.markDirty(row);
            }
        });
        // The first walk sized the columns, and a source may not report its last cells again.
        for (const column of sheet.columns) column.trim();
        return { sheet, texts, formulas, errors, numbered };
    }

    // Makes a sheet that was read one whose cells hold ids and codes of the tables. A sheet to add is in no place
    // yet: nothing may forget a text or a shape before `apply` adds it, as no cell of the workbook holds them yet.
    public adopt({ sheet, texts, formulas, errors, numbered }: Draft): Sheet {
        const textIds = Array.from(texts.keys(), (text) => this.strings.intern(text));
        // A formula may name its own sheet, which the workbook does not hold yet when it is added.
        const own = sheetNameKey(sheet.name);
        const named = (name: string): string | undefined =>
            sheetNameKey(name) === own ? sheet.id : this.named(name)?.id;
        const shapeIds = Array.from(formulas.keys(), (text) => this.shapes.intern(text, named));
        const errorCodes = Array.from(errors.keys(), (text) => this.carry(errorOf(text)));
        // Only the listed cells are read, so a column costs its cells here, however far apart they lie. A cell
        // reported twice is listed twice, and holds an id once it was met.
        for (let c = 0; c < numbered.length; c += 1) {
            const { kind, ref, shape } = sheet.columns[c];
            for (const row of numbered[c]) {
                const number = ~ref[row];
                if (number >= 0) {
                    ref[row] = (kind[row] & KIND_MASK) === CellKind.Text ? textIds[number] : errorCodes[number];
                }
                if (shape[row] < 0) shape[row] = shapeIds[~shape[row]];
            }
        }
        return sheet;
    }

    // Writes the new shape of each block of formulas an edit rewrites, in the places before the edit, then performs
    // the edit, so the shapes travel with their cells.
    public apply(change: Change, fills: readonly number[]): void {
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
                if (insert && rows) sheet.insertRows(index, count);
                else if (insert) sheet.insertColumns(index, count);
                else if (rows) sheet.deleteRows(index, count);
                else sheet.deleteColumns(index, count);
                return;
            }
            case ChangeKind.Move:
                this.known(change.move.toSheet).moveFrom(this.known(change.move.fromSheet), change.move);
                return;
            case ChangeKind.AddSheet:
                // Whatever values its formulas came with were computed against another workbook than this one.
                for (const column of change.sheet.columns) {
                    for (let row = 0; row < column.length; row += 1) {
                        if (column.shape[row] !== 0) column.markDirty(row);
                    }
                }
                this.insert(change.sheet, change.place);
                return;
            case ChangeKind.RemoveSheet: {
                const sheet = this.known(change.sheet);
                this.held.splice(sheet.place, 1);
                this.byId.delete(sheet.id);
                this.byName.delete(sheetNameKey(sheet.name));
                this.limit = 0;
                for (let s = sheet.place; s < this.held.length; s += 1) this.held[s].place = s;
                return;
            }
            case ChangeKind.RenameSheet: {
                const sheet = this.known(change.sheet);
                this.byName.delete(sheetNameKey(sheet.name));
                sheet.name = change.name;
                this.byName.set(sheetNameKey(sheet.name), sheet);
                return;
            }
            default: {
                const sheet = this.known(change.sheet);
                this.held.splice(sheet.place, 1);
                this.insert(sheet, change.place);
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
        return code < CARRIED ? ERRORS[code - 1] : this.carried[code - CARRIED];
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
        const shape = this.shapes.intern(text, (name) => this.named(name)?.id);
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
        this.byName.set(sheetNameKey(sheet.name), sheet);
        for (let s = 0; s < this.held.length; s += 1) this.held[s].place = s;
    }

    private carry(error: FormulaError): number {
        let code = this.carriedCodes.get(error.text);
        if (code === undefined) {
            code = CARRIED + this.carried.length;
            this.carried.push(error);
            this.carriedCodes.set(error.text, code);
        }
        return code;
    }
}

// Reports the cells of a source that hold something, each through the store's door: both walks of a load meet
// the same refusals, as a source may report other cells the second time.
function walk(source: SheetSource, cell: CellSink): void {
    source.cells((row, column, value, formula) => {
        if (value === null && formula === null) return;
        admit(row, column, value);
        cell(row, column, value, formula);
    });
}

// The number of a text in a list of distinct texts in the order they came, from 0.
function listed(list: Map<string, number>, text: string): number {
    let number = list.get(text);
    if (number === undefined) list.set(text, (number = list.size));
    return number;
}
