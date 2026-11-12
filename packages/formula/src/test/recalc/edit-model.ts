// The slow side of the edit law: a workbook as the inputs of its cells, and every structural edit applied to those
// inputs by rules written from what an edit means, not with the package's transforms. A formula is a template with
// its references as the cells they name, wherever its host is, so an edit moves a reference by moving those cells
// and the stored text is printed again from them. A fresh engine loaded from a model is what the engine under test
// must equal.

import type { LineEdit, Literal, Move, SheetSource } from '../../index';
import { Engine } from '../../index';
import { GRID_COLUMNS, GRID_ROWS } from '../../text';

export const CELL = 0;
export const RANGE = 1;
export const COLUMNS = 2;
export const ROWS = 3;

export type Ref = {
    // The id of the sheet it was written with, or null for the host's own.
    readonly sheet: string | null;
    // The name of a sheet that did not exist when it was typed, while no sheet has it.
    readonly name: string | null;
    readonly kind: number;
    // The two corners as typed, as places on the grid, whatever is relative in the text.
    readonly r1: number;
    readonly c1: number;
    readonly r2: number;
    readonly c2: number;
    // Which of the four are written with a $: 1 and 2 for the first row and column, 4 and 8 for the second.
    readonly fixed: number;
    readonly dead: boolean;
};

export type Formula = { readonly parts: readonly string[]; readonly refs: readonly Ref[] };

// A value, a formula, or stored text that is kept as it is: one that does not parse or is never computed.
export type Cell = { readonly value: Literal | null; readonly formula: Formula | null; readonly raw: string | null };

export type ModelSheet = { readonly id: string; readonly name: string; readonly cells: ReadonlyMap<number, Cell> };
export type Model = readonly ModelSheet[];

export const keyOf = (row: number, column: number): number => row * 20000 + column;
export const rowOf = (key: number): number => Math.floor(key / 20000);
export const columnOf = (key: number): number => key % 20000;

function index(value: number, host: number, fixed: number): string {
    if (fixed !== 0) return String(value + 1);
    return value === host ? '' : `[${value - host}]`;
}

function refText(ref: Ref, row: number, column: number): string {
    const prefix = ref.name !== null ? `'${ref.name}'!` : ref.sheet !== null ? `[${ref.sheet}]!` : '';
    if (ref.dead) return `${prefix}#REF!`;
    const rows = ref.kind !== COLUMNS;
    const columns = ref.kind !== ROWS;
    const start =
        (rows ? `R${index(ref.r1, row, ref.fixed & 1)}` : '') +
        (columns ? `C${index(ref.c1, column, ref.fixed & 2)}` : '');
    if (ref.kind === CELL) return prefix + start;
    const end =
        (rows ? `R${index(ref.r2, row, ref.fixed & 4)}` : '') +
        (columns ? `C${index(ref.c2, column, ref.fixed & 8)}` : '');
    return `${prefix}${start}:${end}`;
}

// The stored text of a cell's formula at a host, or null for a value.
export function textOf(cell: Cell, row: number, column: number): string | null {
    if (cell.raw !== null) return cell.raw;
    const { formula } = cell;
    if (formula === null) return null;
    let text = formula.parts[0];
    formula.refs.forEach((ref, i) => {
        text += refText(ref, row, column) + formula.parts[i + 1];
    });
    return text;
}

export function sourcesOf(model: Model): SheetSource[] {
    return model.map((sheet) => ({
        id: sheet.id,
        name: sheet.name,
        cells: (cell) => {
            for (const [key, held] of sheet.cells) {
                const text = textOf(held, rowOf(key), columnOf(key));
                cell(rowOf(key), columnOf(key), text === null ? held.value : null, text);
            }
        },
    }));
}

type Loaded = { engine: Engine; loops: string[] };
const LOADED = new WeakMap<Model, Loaded>();

// A fresh engine over the model's inputs, every formula computed from nothing. A model never changes, so it is
// loaded once.
export function fresh(model: Model): Loaded {
    let loaded = LOADED.get(model);
    if (loaded === undefined) {
        const engine = new Engine(sourcesOf(model));
        const { loops } = engine.recalc(Number.POSITIVE_INFINITY);
        loaded = { engine, loops: loops.map((cell) => `${cell.sheet}!${cell.row},${cell.column}`).sort() };
        LOADED.set(model, loaded);
    }
    return loaded;
}

// One formula cell that an edit left in the workbook: where it is now, and its stored text before and after.
export type Kept = { sheet: string; row: number; column: number; before: string; after: string };
// One cell the edit took out of the workbook, where it was.
export type Gone = { sheet: string; row: number; column: number; cell: Cell };
export type Applied = { model: Model; kept: Kept[]; gone: Gone[] };

type Place = { sheet: string; row: number; column: number } | null;

// Applies an edit given as where every cell goes and what every reference of a host becomes.
function apply(
    model: Model,
    place: (sheet: string, row: number, column: number) => Place,
    refAfter: (ref: Ref, hostBefore: string, hostAfter: string) => Ref,
): Applied {
    const cells = new Map(model.map((sheet) => [sheet.id, new Map<number, Cell>()] as const));
    const kept: Kept[] = [];
    const gone: Gone[] = [];
    for (const sheet of model) {
        for (const [key, cell] of sheet.cells) {
            const row = rowOf(key);
            const column = columnOf(key);
            const to = place(sheet.id, row, column);
            if (to === null) {
                gone.push({ sheet: sheet.id, row, column, cell });
                continue;
            }
            let next = cell;
            if (cell.formula !== null) {
                const refs = cell.formula.refs.map((ref) => refAfter(ref, sheet.id, to.sheet));
                next = { value: null, formula: { parts: cell.formula.parts, refs }, raw: null };
            }
            cells.get(to.sheet)?.set(keyOf(to.row, to.column), next);
            const before = textOf(cell, row, column);
            const after = textOf(next, to.row, to.column);
            if (before !== null && after !== null) kept.push({ ...to, before, after });
        }
    }
    return { model: model.map((sheet) => ({ ...sheet, cells: cells.get(sheet.id) ?? sheet.cells })), kept, gone };
}

// Where a line goes, or -1 when it is deleted or pushed off the axis.
function lineAfter(edit: LineEdit, line: number): number {
    const lines = edit.rows ? GRID_ROWS : GRID_COLUMNS;
    if (line < edit.index) return line;
    if (edit.insert) return line + edit.count < lines ? line + edit.count : -1;
    return line < edit.index + edit.count ? -1 : line - edit.count;
}

export function applyLines(model: Model, edit: LineEdit): Applied {
    const lines = edit.rows ? GRID_ROWS : GRID_COLUMNS;
    const last = edit.index + edit.count;
    return apply(
        model,
        (sheet, row, column) => {
            if (sheet !== edit.sheet) return { sheet, row, column };
            const line = lineAfter(edit, edit.rows ? row : column);
            if (line < 0) return null;
            return edit.rows ? { sheet, row: line, column } : { sheet, row, column: line };
        },
        (ref, host) => {
            if (ref.dead || ref.name !== null || (ref.sheet ?? host) !== edit.sheet) return ref;
            // A whole column names every row, before and after.
            if (ref.kind === (edit.rows ? COLUMNS : ROWS)) return ref;
            const first = edit.rows ? ref.r1 : ref.c1;
            const second = edit.rows ? ref.r2 : ref.c2;
            // A corner off the grid names no cell, and stays where it is.
            if (Math.min(first, second) < 0 || Math.max(first, second) >= lines) return ref;
            let low = Math.min(first, second);
            let high = Math.max(first, second);
            if (edit.insert) {
                if (low >= edit.index) low += edit.count;
                if (low >= lines) return { ...ref, dead: true };
                if (high >= edit.index) high = Math.min(high + edit.count, lines - 1);
            } else {
                if (low >= edit.index && high < last) return { ...ref, dead: true };
                low = low < edit.index ? low : low < last ? edit.index : low - edit.count;
                high = high < edit.index ? high : high < last ? edit.index - 1 : high - edit.count;
            }
            const one = first <= second ? low : high;
            const two = first <= second ? high : low;
            return edit.rows ? { ...ref, r1: one, r2: two } : { ...ref, c1: one, c2: two };
        },
    );
}

// The move as the engine performs it: what would land past the last line of the grid is not part of the block.
export function clipped(move: Move): Move {
    return {
        ...move,
        rows: Math.max(0, Math.min(move.rows, GRID_ROWS - move.row, GRID_ROWS - move.toRow)),
        columns: Math.max(0, Math.min(move.columns, GRID_COLUMNS - move.column, GRID_COLUMNS - move.toColumn)),
    };
}

export function applyMove(model: Model, whole: Move): Applied {
    const move = clipped(whole);
    const down = move.toRow - move.row;
    const across = move.toColumn - move.column;
    const within = (top: number, left: number, row: number, column: number, row2: number, column2: number) =>
        Math.min(row, row2) >= top &&
        Math.max(row, row2) < top + move.rows &&
        Math.min(column, column2) >= left &&
        Math.max(column, column2) < left + move.columns;
    return apply(
        model,
        (sheet, row, column) => {
            if (sheet === move.fromSheet && within(move.row, move.column, row, column, row, column)) {
                return { sheet: move.toSheet, row: row + down, column: column + across };
            }
            // A cell of the block that would leave the grid is cleared, and so is one the block lands on.
            const inWhole =
                row >= whole.row &&
                row < whole.row + whole.rows &&
                column >= whole.column &&
                column < whole.column + whole.columns;
            if (sheet === whole.fromSheet && inWhole) return null;
            if (sheet === move.toSheet && within(move.toRow, move.toColumn, row, column, row, column)) return null;
            return { sheet, row, column };
        },
        (ref, host, hostAfter) => {
            if (ref.dead || ref.name !== null) return ref;
            const read = ref.sheet ?? host;
            const top = ref.kind === COLUMNS ? 0 : ref.r1;
            const bottom = ref.kind === COLUMNS ? GRID_ROWS - 1 : ref.r2;
            const left = ref.kind === ROWS ? 0 : ref.c1;
            const right = ref.kind === ROWS ? GRID_COLUMNS - 1 : ref.c2;
            let next = ref;
            let reads = read;
            if (read === move.fromSheet && within(move.row, move.column, top, left, bottom, right)) {
                reads = move.toSheet;
                next = { ...ref, r1: ref.r1 + down, r2: ref.r2 + down, c1: ref.c1 + across, c2: ref.c2 + across };
            } else if (read === move.toSheet && within(move.toRow, move.toColumn, top, left, bottom, right)) {
                return { ...ref, dead: true };
            }
            // A sheet that was written stays written, and one that was not is written once it is not the host's.
            return { ...next, sheet: ref.sheet === null && reads === hostAfter ? null : reads };
        },
    );
}

// Every reference typed with `name` now reads the sheet of this id.
function bound(model: Model, name: string, id: string): Applied {
    return apply(
        model,
        (sheet, row, column) => ({ sheet, row, column }),
        (ref) => (ref.name === name ? { ...ref, name: null, sheet: id } : ref),
    );
}

export function applyAdd(model: Model, sheet: ModelSheet, place: number): Applied {
    const sheets = model.slice();
    sheets.splice(Math.min(place, sheets.length), 0, sheet);
    const applied = bound(sheets, sheet.name, sheet.id);
    return { ...applied, kept: applied.kept.filter((cell) => cell.sheet !== sheet.id) };
}

export function applyRemove(model: Model, id: string): Model {
    return model.filter((sheet) => sheet.id !== id);
}

export function applyRename(model: Model, id: string, name: string): Applied {
    return bound(
        model.map((sheet) => (sheet.id === id ? { ...sheet, name } : sheet)),
        name,
        id,
    );
}

export function applyReorder(model: Model, id: string, place: number): Model {
    const sheets = model.filter((sheet) => sheet.id !== id);
    const moved = model.find((sheet) => sheet.id === id);
    if (moved !== undefined) sheets.splice(Math.min(place, sheets.length), 0, moved);
    return sheets;
}

export function written(model: Model, sheet: string, row: number, column: number, cell: Cell | null): Model {
    return model.map((held) => {
        if (held.id !== sheet) return held;
        const cells = new Map(held.cells);
        if (cell === null) cells.delete(keyOf(row, column));
        else cells.set(keyOf(row, column), cell);
        return { ...held, cells };
    });
}

// A sheet as a host hands it over to be added: what it holds typed with `name` reads the sheet of this id.
export function rebound(sheet: ModelSheet, name: string, id: string): ModelSheet {
    return bound([sheet], name, id).model[0];
}
