import type { FormulaError } from '../../index';
import { DIV0, Engine, NA } from '../../index';
import { stored } from '../recalc/support';

// Generated sheets of ragged columns for the tests that compare the engine with a model that looks every cell up
// by itself: the cells as the model holds them, and the same cells in an engine beside the formulas to compute.

export type Held = number | string | boolean | null | FormulaError;
// A sheet as a model holds it: per column, the cells from row 0 down.
export type Grid = Held[][];
// `last` is one past the last row that holds a cell: from there on every place is blank.
export type Book = { grid: Grid; formulas: Map<number, string>; last: number };
export type Mix = { readonly errors: number; readonly big: number; readonly odd: number };

export const GRID_ROWS = 1048576;
export const GRID_COLUMNS = 16384;
export const SMALLEST_NORMAL = 2.2250738585072014e-308;

export function isError(value: Held): value is FormulaError {
    return typeof value === 'object' && value !== null;
}

export function generator(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

export function whole(draw: () => number, most: number): number {
    return Math.floor(draw() * (most + 1));
}

export function letters(column: number): string {
    let name = '';
    for (let left = column + 1; left > 0; left = Math.floor((left - 1) / 26)) {
        name = String.fromCharCode(65 + ((left - 1) % 26)) + name;
    }
    return name;
}

// A range of the sheet Data as a formula names it.
export function rangeText(top: number, left: number, rows: number, columns: number): string {
    if (rows === 1 && columns === 1) return `Data!${letters(left)}${top + 1}`;
    if (rows === GRID_ROWS) return `Data!${letters(left)}:${letters(left + columns - 1)}`;
    if (columns === GRID_COLUMNS) return `Data!${top + 1}:${top + rows}`;
    return `Data!${letters(left)}${top + 1}:${letters(left + columns - 1)}${top + rows}`;
}

export function spell(value: Held): string {
    if (isError(value)) return value.text;
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return String(value);
}

// The rows and the columns of a grid that hold a cell, each in order.
export type Filled = { readonly rows: readonly number[]; readonly columns: readonly number[] };

export function filledOf(grid: Grid): Filled {
    const rows = new Set<number>();
    const columns: number[] = [];
    grid.forEach((cells, column) => {
        columns.push(column);
        for (const row of Object.keys(cells)) rows.add(Number(row));
    });
    return { rows: [...rows].sort((a, b) => a - b), columns };
}

// The places along areas of `size` rows, or columns, that start at `starts`, at which one of them reaches a filled
// row, or column, of the grid, in order. At every other place every area is blank, so a model does not look there.
export function live(filled: readonly number[], starts: readonly number[], size: number): number[] {
    const places = new Set<number>();
    for (const start of starts) {
        for (const at of filled) if (at >= start && at - start < size) places.add(at - start);
    }
    return [...places].sort((a, b) => a - b);
}

export const NUMBERS = [0, 1, 2, 3, -1, -2.5, 0.1, 0.7, 1e-3, 12345.678, 1e15, -1e15, 7];
const BIG = [1e200, -1e200, 1e308, 1e-200, 1e155];

function cellOf(draw: () => number, mix: Mix): Held | '=1/0' | '=6*7' | '=NA()' {
    const pick = draw();
    if (pick < mix.errors) return draw() < 0.5 ? (draw() < 0.5 ? DIV0 : NA) : draw() < 0.5 ? '=1/0' : '=NA()';
    if (pick < mix.errors + mix.big) return BIG[Math.floor(draw() * BIG.length)];
    if (pick < mix.errors + mix.big + mix.odd) return draw() < 0.4 ? 'x' : draw() < 0.5 ? draw() < 0.5 : null;
    if (pick > 0.97) return '=6*7';
    return NUMBERS[Math.floor(draw() * NUMBERS.length)];
}

// Columns of the given lengths: numbers mostly, and as `mix` says errors, numbers near the largest, and texts,
// booleans and blanks. Some cells are formulas, and some columns have a text on top.
export function book(draw: () => number, lengths: readonly number[], mix: Mix): Book {
    const grid: Grid = [];
    const formulas = new Map<number, string>();
    let last = 0;
    for (let column = 0; column < lengths.length; column += 1) {
        const cells: Held[] = [];
        for (let row = 0; row < lengths[column]; row += 1) {
            const made = row === 0 && draw() < 0.3 ? `h${column}` : cellOf(draw, mix);
            if (made === '=1/0' || made === '=6*7' || made === '=NA()') {
                formulas.set(row * GRID_COLUMNS + column, made);
                cells.push(made === '=6*7' ? 42 : made === '=1/0' ? DIV0 : NA);
            } else cells.push(made);
        }
        grid[column] = cells;
        last = Math.max(last, cells.length);
    }
    return { grid, formulas, last };
}

// An engine that holds the book as its sheet Data and the formulas down column A of its first sheet, computed.
export function computed(made: Book, texts: readonly string[]): Engine {
    const engine = new Engine([
        {
            id: 's1',
            name: 'Sheet1',
            cells: (cell) => {
                for (let row = 0; row < texts.length; row += 1) cell(row, 0, null, stored(texts[row], `A${row + 1}`));
            },
        },
        {
            id: 'data',
            name: 'Data',
            cells: (cell) => {
                for (let column = 0; column < made.grid.length; column += 1) {
                    const cells = made.grid[column] ?? [];
                    for (let row = 0; row < cells.length; row += 1) {
                        const formula = made.formulas.get(row * GRID_COLUMNS + column);
                        const value = cells[row] ?? null;
                        if (formula !== undefined) cell(row, column, null, stored(formula, 'A1'));
                        else if (value !== null) cell(row, column, value, null);
                    }
                }
            },
        },
    ]);
    engine.recalc(Number.POSITIVE_INFINITY);
    return engine;
}
